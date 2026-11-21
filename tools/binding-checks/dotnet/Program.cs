// Decodes each sample with the generated C# bindings and writes it back out re-encoded.
using Cruma.Tron.Runner.Generated;

var inputDir = args[0];
var outputDir = args[1];
foreach (var path in Directory.GetFiles(inputDir))
{
    var file = Path.GetFileName(path);
    var json = File.ReadAllText(path);
    var encoded = file.Split('.')[0] switch
    {
        "WorkFrame" => WorkFrame.FromJson(json).ToJson(),
        "ReportFrame" => ReportFrame.FromJson(json).ToJson(),
        "AnnounceFrame" => AnnounceFrame.FromJson(json).ToJson(),
        "StartCommand" => StartCommand.FromJson(json).ToJson(),
        var other => throw new InvalidOperationException($"no consumer for sample {other}"),
    };
    File.WriteAllText(Path.Combine(outputDir, file), encoded);
}
