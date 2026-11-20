#[path = "../../../src-tauri/src/config/proxy_chain.rs"]
mod proxy_chain;
use std::io::{self, Read};
fn main() {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap();
    let mut cfg: serde_yaml_ng::Mapping = serde_yaml_ng::from_str(&input).unwrap();
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--url-test") {
        let global = args.get(2).map(String::as_str).filter(|s| !s.is_empty());
        let mut overrides = std::collections::HashMap::new();
        if let Some(group_url) = args.get(3).filter(|s| !s.is_empty()) {
            overrides.insert("G".to_string(), group_url.to_owned());
        }
        proxy_chain::apply_test_urls(&mut cfg, global, &overrides);
        print!("{}", serde_yaml_ng::to_string(&cfg).unwrap());
        return;
    }
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
