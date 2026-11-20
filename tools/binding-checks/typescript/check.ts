// Decodes each sample with the generated TypeScript bindings and writes it back out re-encoded.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Convert } from "../../../packages/typescript/src/generated/protocol.ts";

const [inputDir, outputDir] = process.argv.slice(2) as [string, string];
const codecs: Record<string, (json: string) => string> = {
  WorkFrame: (json) => Convert.workFrameToJson(Convert.toWorkFrame(json)),
  ReportFrame: (json) => Convert.reportFrameToJson(Convert.toReportFrame(json)),
  AnnounceFrame: (json) => Convert.announceFrameToJson(Convert.toAnnounceFrame(json)),
  StartCommand: (json) => Convert.startCommandToJson(Convert.toStartCommand(json)),
};
for (const file of readdirSync(inputDir)) {
  const codec = codecs[file.split(".")[0] as string];
  if (!codec) throw new Error(`no consumer for sample ${file}`);
  writeFileSync(join(outputDir, file), codec(readFileSync(join(inputDir, file), "utf8")));
}
