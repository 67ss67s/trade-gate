//! exec-core —— Trading Swarm 执行核心的 **REST/主账户** 半边(工作包 A1)。
//!
//! 代码来源:从一套内部生产交易系统的 `exchanges/binance.rs`、
//! `{account_stream,network,market}.rs` **移植**后剥离原有框架依赖独立演进
//! (不引用、不回改那套系统)。逐条来源与删改清单见 `README.md`。
//!
//! 边界(AGENTS.md 硬规则):凭证只进 execd —— 本 crate 是唯一持有主账户
//! API key/secret 的地方;不实现任何提币端点(默认不勾提币,
//! 提币走 Binance UI 深链)。
//!
//! 对外结构约定:金额/价格/数量一律**十进制字符串**,时间戳一律 **unix 毫秒整数**,
//! JSON 字段 `snake_case`。

pub mod account_stream;
pub mod binance;
pub mod demo_exec;
pub mod error;
pub mod filters;
pub mod ids;
pub mod network;
pub mod ratelimit;
pub mod secrets;

pub use demo_exec::{DemoError, DemoErrorKind, DemoExec};
pub use error::{BinanceError, BinanceErrorKind};
pub use filters::{SymbolRules, allocate_lots, decimal_text};
pub use ids::{ClientOrderId, Leg, is_foreign, is_local};
pub use ratelimit::{RestGate, RestRateLimiter};
pub use secrets::{MainCredentials, SecretString};
