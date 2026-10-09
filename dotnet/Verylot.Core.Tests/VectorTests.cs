using System.Text.Json.Nodes;
using Verylot.Core;

namespace Verylot.Core.Tests;

/// <summary>The reference implementation against test-vectors/v1.json (the JS verifier runs the same file).</summary>
public class VectorTests
{
    private static readonly JsonNode V = JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "v1.json")))!;

    private static IEnumerable<JsonNode> All(string key) => V[key]!.AsArray().Select(n => n!);
    private static byte[] Hex(JsonNode? n) => Convert.FromHexString((string)n!);

    [Fact]
    public void Slots()
    {
        foreach (var s in All("slots"))
        {
            var slot = (long)s["slot"]!;
            Assert.Equal((string)s["time"]!, SlotClock.ToTime(slot).ToString("yyyy-MM-dd'T'HH:mm:ss'Z'"));
            Assert.Equal((string)s["day"]!, SlotClock.DayOf(slot).ToString("yyyy-MM-dd"));
            Assert.Equal((int)s["indexInDay"]!, SlotClock.IndexInDay(slot));
            Assert.Equal((long)s["drandRound"]!, DrandChain.Quicknet.RoundForSlot(slot));
        }
    }

    [Fact]
    public void ChainFromRoot()
    {
        var c = V["chain"]!;
        var chain = SeedChain.FromRoot(DateOnly.Parse((string)c["day"]!), Hex(c["root"]));
        Assert.Equal(Hex(c["commitment"]), chain.Commitment);
        foreach (var s in c["seeds"]!.AsArray())
            Assert.Equal(Hex(s!["seed"]), chain.SeedForIndex((int)s["indexInDay"]!));
    }

    [Fact]
    public void ChainChecks()
    {
        foreach (var c in All("chainChecks"))
            Assert.True((bool)c["valid"]! == SeedChain.Verify(Hex(c["seed"]), (int)c["indexInDay"]!, Hex(c["commitment"])), (string)c["note"]!);
    }

    [Fact]
    public void Digits()
    {
        foreach (var d in All("digits"))
            Assert.Equal((int)d["digit"]!, DigitDerivation.Derive(Hex(d["seed"]), (long)d["slot"]!, Hex(d["drandRandomness"])));
    }
}
