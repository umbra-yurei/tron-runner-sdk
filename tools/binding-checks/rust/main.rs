// Decodes each sample with the generated Rust bindings and writes it back out re-encoded.
#![allow(dead_code)]
#[path = "protocol.rs"]
mod protocol;

use protocol::{AnnounceFrame, ReportFrame, StartCommand, WorkFrame};
use serde::{de::DeserializeOwned, Serialize};
use std::{env, fs, path::Path};

fn round_trip<T: DeserializeOwned + Serialize>(input: &Path, output: &Path) {
    let decoded: T = serde_json::from_str(&fs::read_to_string(input).unwrap()).unwrap();
    fs::write(output, serde_json::to_string(&decoded).unwrap()).unwrap();
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let (input_dir, output_dir) = (Path::new(&args[1]), Path::new(&args[2]));
    for entry in fs::read_dir(input_dir).unwrap() {
        let path = entry.unwrap().path();
        let file = path.file_name().unwrap().to_str().unwrap().to_owned();
        let out = output_dir.join(&file);
        match file.split('.').next().unwrap() {
            "WorkFrame" => round_trip::<WorkFrame>(&path, &out),
            "ReportFrame" => round_trip::<ReportFrame>(&path, &out),
            "AnnounceFrame" => round_trip::<AnnounceFrame>(&path, &out),
            "StartCommand" => round_trip::<StartCommand>(&path, &out),
            other => panic!("no consumer for sample {other}"),
        }
    }
}
