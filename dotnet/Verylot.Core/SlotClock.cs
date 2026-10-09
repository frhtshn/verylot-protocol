namespace Verylot.Core;

/// <summary>
/// Time ↔ slot conversion. One slot = one digit = 10 seconds, all in UTC.
/// A slot's id is simply unix_seconds / 10, so any timestamp maps to its digit without a lookup.
/// </summary>
public static class SlotClock
{
    public const int SlotSeconds = 10;
    public const int SlotsPerDay = 86_400 / SlotSeconds; // 8640

    private const long SlotTicks = SlotSeconds * TimeSpan.TicksPerSecond;

    // Verylot only deals with post-1970 times, so plain integer division is a floor.
    public static long ToSlot(long unixSeconds) => unixSeconds / SlotSeconds;

    /// <summary>The slot that starts at or after <paramref name="time"/> (12:00:05 → 12:00:10).</summary>
    public static long CeilingSlot(DateTimeOffset time)
    {
        var ticks = time.UtcTicks - DateTimeOffset.UnixEpoch.UtcTicks;
        return (ticks + SlotTicks - 1) / SlotTicks;
    }

    public static long FloorSlot(DateTimeOffset time) => ToSlot(time.ToUnixTimeSeconds());

    public static DateTimeOffset ToTime(long slot) => DateTimeOffset.FromUnixTimeSeconds(slot * SlotSeconds);

    public static DateOnly DayOf(long slot) => DateOnly.FromDateTime(ToTime(slot).UtcDateTime);

    public static long FirstSlotOf(DateOnly day) =>
        ToSlot(new DateTimeOffset(day.ToDateTime(TimeOnly.MinValue), TimeSpan.Zero).ToUnixTimeSeconds());

    /// <summary>0-based position of the slot inside its UTC day (0 … 8639).</summary>
    public static int IndexInDay(long slot) => (int)(slot - FirstSlotOf(DayOf(slot)));
}
