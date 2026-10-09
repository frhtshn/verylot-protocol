using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json.Serialization;

namespace Verylot.Core;

/// <summary>Public parameters of a drand chain.</summary>
public sealed record DrandChain(string Hash, long GenesisTime, int Period)
{
    /// <summary>League of Entropy "quicknet": unchained BLS on G1, a beacon every 3 seconds.</summary>
    public static readonly DrandChain Quicknet = new(
        "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971",
        GenesisTime: 1692803367,
        Period: 3);

    public long RoundTime(long round) => GenesisTime + (round - 1) * Period;

    /// <summary>The first round published at or after <paramref name="unixSeconds"/>. Fixed by formula — never chosen.</summary>
    public long RoundAtOrAfter(long unixSeconds)
    {
        if (unixSeconds <= GenesisTime) return 1;
        var elapsed = unixSeconds - GenesisTime;
        return (elapsed + Period - 1) / Period + 1;
    }

    public long RoundForSlot(long slot) => RoundAtOrAfter(slot * SlotClock.SlotSeconds);
}

public sealed record DrandBeacon(long Round, byte[] Randomness, byte[] Signature);

/// <summary>
/// Fetches beacons from public drand relays. Checks randomness == SHA256(signature). BLS signatures are not checked here;
/// verifiers check them independently with drand's official client.
///
/// Two modes, to stay a polite client of free public infrastructure:
/// - live (the round is new): all relays are raced, because the digit can't be shown before this returns;
/// - catch-up (the round is older than <see cref="LiveWindow"/>, e.g. after an outage): one relay per
///   request, rotating, throttled to <see cref="CatchUpInterval"/>.
/// A relay that answers 429/403/503 is put in cooldown (honouring Retry-After, doubling on repeats) and
/// skipped until it ends; each cooldown is reported through <paramref name="warn"/>.
/// </summary>
public sealed class DrandClient(HttpClient http, DrandChain chain, Action<string>? warn = null)
{
    private static readonly string[] Relays =
    [
        "https://api.drand.sh",
        "https://api2.drand.sh",
        "https://api3.drand.sh",
        "https://drand.cloudflare.com",
    ];

    /// <summary>Rounds published longer ago than this are fetched in catch-up mode.</summary>
    public static readonly TimeSpan LiveWindow = TimeSpan.FromSeconds(30);
    /// <summary>Minimum gap between catch-up requests (≈ 5 requests/s in total).</summary>
    public static readonly TimeSpan CatchUpInterval = TimeSpan.FromMilliseconds(200);

    private static readonly TimeSpan DefaultCooldown = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan MaxCooldown = TimeSpan.FromMinutes(10);

    private readonly Lock _gate = new();
    private readonly Dictionary<string, (DateTimeOffset Until, TimeSpan Last)> _cooldowns = [];
    private DateTimeOffset _nextCatchUpRequest = DateTimeOffset.MinValue;
    private int _rotation;

    public DrandChain Chain { get; } = chain;

    /// <summary>Waits until the round is published and fetched, polling every <paramref name="pollInterval"/>.</summary>
    public async Task<DrandBeacon> GetRoundAsync(long round, TimeSpan pollInterval, CancellationToken ct = default)
    {
        var published = DateTimeOffset.FromUnixTimeSeconds(Chain.RoundTime(round));
        while (true)
        {
            var wait = published - DateTimeOffset.UtcNow;
            if (wait > TimeSpan.Zero) await Task.Delay(wait, ct);

            var catchUp = DateTimeOffset.UtcNow - published > LiveWindow;
            var beacon = catchUp ? await TryCatchUpAsync(round, ct) : await TryGetRoundAsync(round, ct);
            if (beacon is not null) return beacon;

            var cooled = UntilAnyRelayAvailable();
            await Task.Delay(cooled > pollInterval ? cooled : pollInterval, ct);
        }
    }

    /// <summary>
    /// Live mode: asks every relay not in cooldown at once and returns the first valid beacon, or null if
    /// none has the round yet.
    /// </summary>
    public async Task<DrandBeacon?> TryGetRoundAsync(long round, CancellationToken ct = default)
    {
        var relays = AvailableRelays();
        if (relays.Count == 0) return null;

        using var race = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var pending = relays.Select(relay => FetchFromRelayAsync(relay, round, race.Token)).ToList();
        try
        {
            while (pending.Count > 0)
            {
                var done = await Task.WhenAny(pending);
                pending.Remove(done);
                if (await done is { } beacon) return beacon;
            }
            return null;
        }
        finally
        {
            await race.CancelAsync();
        }
    }

    /// <summary>Catch-up mode: one throttled request to the next available relay in rotation.</summary>
    private async Task<DrandBeacon?> TryCatchUpAsync(long round, CancellationToken ct)
    {
        var relays = AvailableRelays();
        if (relays.Count == 0) return null;

        TimeSpan wait;
        string relay;
        lock (_gate)
        {
            var now = DateTimeOffset.UtcNow;
            var at = _nextCatchUpRequest > now ? _nextCatchUpRequest : now;
            _nextCatchUpRequest = at + CatchUpInterval;
            wait = at - now;
            relay = relays[_rotation++ % relays.Count];
        }
        if (wait > TimeSpan.Zero) await Task.Delay(wait, ct);

        return await FetchFromRelayAsync(relay, round, ct);
    }

    private async Task<DrandBeacon?> FetchFromRelayAsync(string relay, long round, CancellationToken ct)
    {
        try
        {
            using var response = await http.GetAsync($"{relay}/{Chain.Hash}/public/{round}", ct);
            if (response.StatusCode is HttpStatusCode.TooManyRequests or HttpStatusCode.Forbidden or HttpStatusCode.ServiceUnavailable)
            {
                CoolDown(relay, $"answered {(int)response.StatusCode} {response.StatusCode}", RetryAfter(response));
                return null;
            }
            if (!response.IsSuccessStatusCode) return null;

            var dto = await response.Content.ReadFromJsonAsync<BeaconDto>(ct);
            if (dto is null || dto.Round != round) return null;

            var beacon = new DrandBeacon(dto.Round, Convert.FromHexString(dto.Randomness), Convert.FromHexString(dto.Signature));
            // A relay serving a bad beacon is skipped like a rate-limited one; another relay wins the race.
            if (!SHA256.HashData(beacon.Signature).AsSpan().SequenceEqual(beacon.Randomness))
            {
                CoolDown(relay, $"sent round {round} with randomness != SHA256(signature)", null);
                return null;
            }

            lock (_gate) _cooldowns.Remove(relay);
            return beacon;
        }
        catch (HttpRequestException) { return null; }
        catch (Exception e) when (e is FormatException or System.Text.Json.JsonException) { return null; }   // malformed answer
        catch (OperationCanceledException) { return null; }   // timeout, or another relay won the race
    }

    private static TimeSpan? RetryAfter(HttpResponseMessage response) => response.Headers.RetryAfter switch
    {
        { Delta: { } delta } => delta,
        { Date: { } date } => date - DateTimeOffset.UtcNow,
        _ => null,
    };

    private void CoolDown(string relay, string why, TimeSpan? retryAfter)
    {
        TimeSpan cooldown;
        lock (_gate)
        {
            var previous = _cooldowns.TryGetValue(relay, out var c) ? c.Last : TimeSpan.Zero;
            cooldown = retryAfter is { } r && r > TimeSpan.Zero
                ? r
                : previous == TimeSpan.Zero ? DefaultCooldown : previous * 2;
            if (cooldown > MaxCooldown) cooldown = MaxCooldown;
            _cooldowns[relay] = (DateTimeOffset.UtcNow + cooldown, cooldown);
        }

        warn?.Invoke($"drand relay {relay} {why}; " +
                     $"skipping it for {cooldown.TotalSeconds:0}s{(retryAfter is null ? "" : " (Retry-After)")}");
    }

    private List<string> AvailableRelays()
    {
        var now = DateTimeOffset.UtcNow;
        lock (_gate)
            return Relays.Where(r => !_cooldowns.TryGetValue(r, out var c) || c.Until <= now).ToList();
    }

    /// <summary>Zero if a relay is usable now, otherwise how long until the first cooldown ends.</summary>
    private TimeSpan UntilAnyRelayAvailable()
    {
        var now = DateTimeOffset.UtcNow;
        lock (_gate)
        {
            if (Relays.Any(r => !_cooldowns.TryGetValue(r, out var c) || c.Until <= now)) return TimeSpan.Zero;
            return _cooldowns.Values.Min(c => c.Until) - now;
        }
    }

    private sealed record BeaconDto(
        [property: JsonPropertyName("round")] long Round,
        [property: JsonPropertyName("randomness")] string Randomness,
        [property: JsonPropertyName("signature")] string Signature);
}
