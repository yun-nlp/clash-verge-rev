#[path = "../../../src-tauri/src/config/proxy_chain.rs"]
mod proxy_chain;
use std::io::{self, Read};
fn main() {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap();
    let mut cfg: serde_yaml_ng::Mapping = serde_yaml_ng::from_str(&input).unwrap();
    let chain = proxy_chain::ProxyChain {
        group: "Rule".into(),
        nodes: vec![
            proxy_chain::ChainNode {
                name: "A".into(),
                provider: None,
                group: true,
            },
            proxy_chain::ChainNode {
                name: "B".into(),
                provider: None,
                group: true,
            },
        ],
    };
    let name = proxy_chain::install(&mut cfg, &chain).unwrap();
    let rules = cfg.get_mut("rules").unwrap().as_sequence_mut().unwrap();
    rules.clear();
    rules.push(format!("MATCH,Rule").into());
    eprintln!("{name}");
    print!("{}", serde_yaml_ng::to_string(&cfg).unwrap());
}
