use serde::{Deserialize, Serialize};
use std::io::{self, BufRead};

#[derive(Debug, Deserialize)]
struct Request {
    amountIn: String,
    quote1Out: String,
    quote1MinOut: String,
    quote2Out: String,
    quote2MinOut: String,
    minProfit: String,
    #[serde(alias = "feeEstimateLamports")]
    feeEstimateInInputUnits: String,
}

#[derive(Debug, Serialize)]
struct Response {
    profitable: bool,
    profit: String,
    conservativeProfit: String,
}

fn parse_i128(s: &str) -> Result<i128, String> {
    s.parse::<i128>().map_err(|e| format!("invalid int: {s}: {e}"))
}

fn main() {
    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                eprintln!("{e}");
                std::process::exit(1);
            }
        };

        if line.trim().is_empty() {
            continue;
        }

        let req: Request = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("{e}");
                std::process::exit(1);
            }
        };

        let amount_in = match parse_i128(&req.amountIn) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("{e}");
                std::process::exit(1);
            }
        };
        let out = match parse_i128(&req.quote2Out) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("{e}");
                std::process::exit(1);
            }
        };
        let out_min = match parse_i128(&req.quote2MinOut) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("{e}");
                std::process::exit(1);
            }
        };
    let min_profit = match parse_i128(&req.minProfit) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    };
    let fee_estimate = match parse_i128(&req.feeEstimateInInputUnits) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    };

    let profit = out - amount_in - fee_estimate;
    let conservative_profit = out_min - amount_in - fee_estimate;
        let profitable = conservative_profit >= min_profit;

        let res = Response {
            profitable,
            profit: profit.to_string(),
            conservativeProfit: conservative_profit.to_string(),
        };

        println!("{}", serde_json::to_string(&res).unwrap());
    }
}
