using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

namespace Verylot.Core;

/// <summary>
/// digit = unbiased_map( HMAC-SHA256(key: seed, msg: "verylot/digit/v1" || slot (int64 BE) || counter (uint32 BE) || drand_randomness) )
///
/// unbiased_map: scan the 32 bytes in order, take the first byte b &lt; 250 and return b % 10
/// (250 = 25 × 10, so every digit has exactly 25/250 = 10% probability).
/// If all 32 bytes are ≥ 250 (≈ 10⁻⁵² chance) the counter is incremented and the HMAC recomputed.
/// </summary>
public static class DigitDerivation
{
    private const int AcceptBelow = 250;
    private static readonly byte[] DigitTag = Encoding.ASCII.GetBytes("verylot/digit/v1");

    public static int Derive(ReadOnlySpan<byte> seed, long slot, ReadOnlySpan<byte> drandRandomness)
    {
        Span<byte> message = stackalloc byte[DigitTag.Length + 8 + 4 + drandRandomness.Length];
        DigitTag.CopyTo(message);
        BinaryPrimitives.WriteInt64BigEndian(message[DigitTag.Length..], slot);
        drandRandomness.CopyTo(message[(DigitTag.Length + 12)..]);

        Span<byte> mac = stackalloc byte[HMACSHA256.HashSizeInBytes];
        for (uint counter = 0; ; counter++)
        {
            BinaryPrimitives.WriteUInt32BigEndian(message[(DigitTag.Length + 8)..], counter);
            HMACSHA256.HashData(seed, message, mac);

            foreach (var b in mac)
                if (b < AcceptBelow)
                    return b % 10;
        }
    }
}
