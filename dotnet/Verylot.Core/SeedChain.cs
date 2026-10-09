using System.Security.Cryptography;
using System.Text;

namespace Verylot.Core;

/// <summary>
/// One UTC day's commit–reveal seed chain.
///
///   s[8640] = secret root (32 random bytes)
///   s[k-1]  = SHA256("verylot/chain/v1" || s[k])
///   s[0]    = commitment, published before the day starts
///
/// Slot with day index i uses s[i+1]. Seeds are revealed in order s[1], s[2], …;
/// each revealed seed hashes to the previous one, so nothing can be swapped after the commitment.
/// </summary>
public sealed class SeedChain
{
    public const int SeedLength = 32;
    private static readonly byte[] ChainTag = Encoding.ASCII.GetBytes("verylot/chain/v1");

    private readonly byte[][] _seeds;

    private SeedChain(DateOnly day, byte[][] seeds)
    {
        Day = day;
        _seeds = seeds;
    }

    public DateOnly Day { get; }

    public byte[] Commitment => _seeds[0];

    /// <summary>The secret root s[8640]. Must be stored sealed, never published.</summary>
    public byte[] Root => _seeds[SlotClock.SlotsPerDay];

    public static SeedChain Create(DateOnly day) => FromRoot(day, RandomNumberGenerator.GetBytes(SeedLength));

    public static SeedChain FromRoot(DateOnly day, byte[] root)
    {
        if (root.Length != SeedLength) throw new ArgumentException($"Root must be {SeedLength} bytes.", nameof(root));

        var seeds = new byte[SlotClock.SlotsPerDay + 1][];
        seeds[SlotClock.SlotsPerDay] = root;
        for (var k = SlotClock.SlotsPerDay; k > 0; k--)
            seeds[k - 1] = Step(seeds[k]);

        return new SeedChain(day, seeds);
    }

    public byte[] SeedForIndex(int indexInDay)
    {
        if ((uint)indexInDay >= SlotClock.SlotsPerDay) throw new ArgumentOutOfRangeException(nameof(indexInDay));
        return _seeds[indexInDay + 1];
    }

    public byte[] SeedForSlot(long slot)
    {
        if (SlotClock.DayOf(slot) != Day) throw new ArgumentException($"Slot {slot} is not in {Day:yyyy-MM-dd}.", nameof(slot));
        return SeedForIndex(SlotClock.IndexInDay(slot));
    }

    public static byte[] Step(byte[] seed) => SHA256.HashData([.. ChainTag, .. seed]);

    /// <summary>Checks that hashing <paramref name="seed"/> (revealed for day index i) i+1 times yields the commitment.</summary>
    public static bool Verify(byte[] seed, int indexInDay, byte[] commitment)
    {
        var x = seed;
        for (var k = 0; k <= indexInDay; k++)
            x = Step(x);
        return CryptographicOperations.FixedTimeEquals(x, commitment);
    }
}
