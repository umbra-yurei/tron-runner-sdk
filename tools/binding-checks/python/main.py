"""Decodes each sample with the generated Python bindings and writes it back out re-encoded."""
import json
import sys
from pathlib import Path

generated_dir, input_dir, output_dir = (Path(arg) for arg in sys.argv[1:4])
sys.path.insert(0, str(generated_dir))
import protocol  # noqa: E402

CODECS = {
    "WorkFrame": (protocol.work_frame_from_dict, protocol.work_frame_to_dict),
    "ReportFrame": (protocol.report_frame_from_dict, protocol.report_frame_to_dict),
    "AnnounceFrame": (protocol.announce_frame_from_dict, protocol.announce_frame_to_dict),
    "StartCommand": (protocol.start_command_from_dict, protocol.start_command_to_dict),
}

for sample in sorted(input_dir.iterdir()):
    from_dict, to_dict = CODECS[sample.name.split(".")[0]]
    (output_dir / sample.name).write_text(json.dumps(to_dict(from_dict(json.loads(sample.read_text())))))
