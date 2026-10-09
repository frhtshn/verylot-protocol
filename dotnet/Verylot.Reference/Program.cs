using System.Collections.Concurrent;
using System.Text.Json;
using Verylot.Core;

// Reference generator: a complete, self-hosted Verylot v1 digit stream with no database.
//
//  - Keeps day chains CommitDaysAhead days ahead; each day's secret root and public commitment live in <data>/<day>.json.
//  - Produces one digit per 10-second slot from (seed × drand quicknet), strictly in order, and appends it to
//    <data>/<day>.digits.jsonl. After downtime it catches up from the last produced slot; it never skips one.
//  - Serves the same JSON as api.verylot.online, so `verylot-verify --api http://localhost:5080` checks it.
//
// The root files are the only secret. Anyone who reads one can predict that day's digits once drand publishes,
// so keep the data directory private and back it up.

var builder = WebApplication.CreateBuilder(args);
var dataDir = Path.GetFullPath(builder.Configuration["Data"] ?? "data");
Directory.CreateDirectory(dataDir);

var store = new Store(dataDir);
builder.Services.AddSingleton(store);
builder.Services.AddHostedService<Producer>();
builder.Services.ConfigureHttpJsonOptions(o => o.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase);

var app = builder.Build();

app.MapGet("/v1/commitments", (DateOnly? from, DateOnly? to) =>
{
    var today = DateOnly.FromDateTime(DateTime.UtcNow);
    from ??= today.AddDays(-7);
    to ??= today.AddDays(7);
    if (to < from || to.Value.DayNumber - from.Value.DayNumber > 366) return Results.BadRequest("Range must be 0–366 days.");
    return Results.Ok(store.Days(from.Value, to.Value).Select(d => new { d.Day, d.Commitment, d.CommittedAt }));
});

app.MapGet("/v1/stream/proof", (long from, int count = 6) =>
{
    if (from < 0 || count is < 1 or > 100) return Results.BadRequest("from must be >= 0 and count 1–100.");
    var proofs = new List<object>();
    for (var slot = from; slot < from + count; slot++)
    {
        if (store.Digit(slot) is not { } d) continue;
        var day = store.Day(SlotClock.DayOf(slot))!;
        proofs.Add(new
        {
            d.Slot, Time = Store.Iso(slot), d.Digit, Seed = Convert.ToHexStringLower(day.Chain.SeedForSlot(slot)),
            d.DrandRound, d.DrandRandomness, d.DrandSignature, day.Day, day.Commitment,
        });
    }
    return Results.Ok(proofs);
});

app.MapGet("/v1/stream/latest", (int count = 60) =>
    store.Latest(Math.Clamp(count, 1, 600)).Select(d => new { d.Slot, Time = Store.Iso(d.Slot), d.Digit }));

app.Run();

public sealed record Produced(long Slot, int Digit, long DrandRound, string DrandRandomness, string DrandSignature);

public sealed record DayFile(string Day, string Root, string Commitment, DateTimeOffset CommittedAt)
{
    public SeedChain Chain { get; } = SeedChain.FromRoot(DateOnly.Parse(Day), Convert.FromHexString(Root));
}

public sealed class Store
{
    public const int CommitDaysAhead = 7;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly string _dir;
    private readonly ConcurrentDictionary<DateOnly, DayFile> _days = new();
    private readonly ConcurrentDictionary<long, Produced> _digits = new();
    private readonly Lock _write = new();

    public Store(string dir)
    {
        _dir = dir;
        // shortcut: every produced digit is held in memory (~1 MB a day); prune or page from disk for long-running instances.
        foreach (var file in Directory.EnumerateFiles(dir, "????-??-??.json"))
        {
            var day = JsonSerializer.Deserialize<DayFile>(File.ReadAllText(file), Json)!;
            _days[DateOnly.Parse(day.Day)] = day;
        }
        foreach (var file in Directory.EnumerateFiles(dir, "*.digits.jsonl"))
        foreach (var line in File.ReadLines(file).Where(l => l.Length > 0))
        {
            var d = JsonSerializer.Deserialize<Produced>(line, Json)!;
            _digits[d.Slot] = d;
        }
    }

    public static string Iso(long slot) => SlotClock.ToTime(slot).ToString("yyyy-MM-dd'T'HH:mm:ss'Z'");

    public long? LastProducedSlot => _digits.IsEmpty ? null : _digits.Keys.Max();

    public DayFile? Day(DateOnly day) => _days.GetValueOrDefault(day);

    public IEnumerable<DayFile> Days(DateOnly from, DateOnly to) => _days.Values.Where(d => DateOnly.Parse(d.Day) is var x && x >= from && x <= to).OrderBy(d => d.Day);

    public Produced? Digit(long slot) => _digits.GetValueOrDefault(slot);

    public IEnumerable<Produced> Latest(int count) => _digits.Values.OrderByDescending(d => d.Slot).Take(count).Reverse();

    /// <summary>Creates the chains of today and the next <see cref="CommitDaysAhead"/> days that don't exist yet.</summary>
    public void EnsureCommitments(DateTimeOffset now)
    {
        var today = DateOnly.FromDateTime(now.UtcDateTime);
        for (var day = today; day <= today.AddDays(CommitDaysAhead); day = day.AddDays(1))
        {
            if (_days.ContainsKey(day)) continue;
            var chain = SeedChain.Create(day);
            var file = new DayFile(day.ToString("yyyy-MM-dd"), Convert.ToHexStringLower(chain.Root), Convert.ToHexStringLower(chain.Commitment), now);
            var path = Path.Combine(_dir, $"{file.Day}.json");
            // Write-then-rename: a crash never leaves a half-written root behind a published commitment.
            File.WriteAllText(path + ".tmp", JsonSerializer.Serialize(file, Json));
            File.Move(path + ".tmp", path);
            _days[day] = file;
        }
    }

    public void Save(Produced digit)
    {
        lock (_write)
            File.AppendAllText(Path.Combine(_dir, $"{SlotClock.DayOf(digit.Slot):yyyy-MM-dd}.digits.jsonl"), JsonSerializer.Serialize(digit, Json) + "\n");
        _digits[digit.Slot] = digit;
    }
}

/// <summary>Produces every slot in order, waiting for its drand round. Slots before a day's commitment are not produced.</summary>
public sealed class Producer(Store store, ILogger<Producer> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        var drand = new DrandClient(new HttpClient { Timeout = TimeSpan.FromSeconds(5) }, DrandChain.Quicknet, w => log.LogWarning("{Warning}", w));
        store.EnsureCommitments(DateTimeOffset.UtcNow);

        var slot = store.LastProducedSlot + 1 ?? SlotClock.CeilingSlot(DateTimeOffset.UtcNow);
        while (!ct.IsCancellationRequested)
        {
            var slotTime = SlotClock.ToTime(slot);
            var wait = slotTime - DateTimeOffset.UtcNow;
            if (wait > TimeSpan.Zero) await Task.Delay(wait, ct);
            store.EnsureCommitments(DateTimeOffset.UtcNow);

            var day = store.Day(SlotClock.DayOf(slot));
            if (day is null || day.CommittedAt >= slotTime)
            {
                slot++;   // committed too late for this slot: leave it unproduced rather than claim a commitment it never had
                continue;
            }

            var round = drand.Chain.RoundForSlot(slot);
            var beacon = await drand.GetRoundAsync(round, TimeSpan.FromMilliseconds(200), ct);
            var digit = DigitDerivation.Derive(day.Chain.SeedForSlot(slot), slot, beacon.Randomness);
            store.Save(new Produced(slot, digit, round, Convert.ToHexStringLower(beacon.Randomness), Convert.ToHexStringLower(beacon.Signature)));
            log.LogInformation("{Time} slot {Slot} drand #{Round} -> {Digit}", Store.Iso(slot), slot, round, digit);
            slot++;
        }
    }
}
