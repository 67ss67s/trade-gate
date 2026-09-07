/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Source of truth: packages/contracts/{schema,transitions,tables}/*.json
 * Regenerate: `npm run generate` in packages/contracts (`npm run generate:check` verifies in CI).
 * Changing schema/transitions/tables is a main-line-only change — see docs/contracts/README.md §10.
 */

export const schemas = {
  "account_snapshot": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://trading-swarm.dev/schema/account_snapshot.json",
    "title": "AccountSnapshot",
    "description": "账户真相(设计 §6.2 account.truth / Codex review #6):每个组件各自 observed_at、取数区间、completeness;经济组件哈希 = account_version;组件缺失或跨度过大 → inconsistent(gate 拒开仓);不可得 → unavailable。",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schema_version",
      "account",
      "channel",
      "computed_at",
      "consistency",
      "components"
    ],
    "properties": {
      "schema_version": {
        "$ref": "common.json#/$defs/SchemaVersion"
      },
      "account": {
        "$ref": "common.json#/$defs/AccountRef"
      },
      "channel": {
        "$ref": "common.json#/$defs/Channel"
      },
      "computed_at": {
        "$ref": "common.json#/$defs/TimestampMs"
      },
      "consistency": {
        "$ref": "common.json#/$defs/Consistency"
      },
      "consistency_reason": {
        "type": "string",
        "maxLength": 500
      },
      "account_version": {
        "$ref": "common.json#/$defs/Hash256",
        "description": "sha256(canonical_json({balances,positions,open_orders,position_mode} 的 data)),见 docs/contracts/README.md"
      },
      "span_ms": {
        "type": "integer",
        "minimum": 0,
        "description": "各必需组件 observed_at 的最大差"
      },
      "components": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "balances",
          "positions",
          "open_orders",
          "position_mode"
        ],
        "properties": {
          "balances": {
            "$ref": "#/$defs/BalancesComponent"
          },
          "positions": {
            "$ref": "#/$defs/PositionsComponent"
          },
          "open_orders": {
            "$ref": "#/$defs/OrdersComponent"
          },
          "position_mode": {
            "$ref": "#/$defs/PositionModeComponent"
          },
          "recent_fills": {
            "$ref": "#/$defs/FillsComponent"
          },
          "order_history": {
            "$ref": "#/$defs/OrdersComponent"
          },
          "margin": {
            "$ref": "#/$defs/MarginComponent"
          }
        }
      },
      "summary": {
        "$ref": "#/$defs/AccountSummary"
      }
    },
    "$defs": {
      "BalanceRow": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "asset",
          "wallet",
          "wallet_balance",
          "available"
        ],
        "properties": {
          "asset": {
            "$ref": "common.json#/$defs/Asset"
          },
          "wallet": {
            "$ref": "common.json#/$defs/Wallet"
          },
          "wallet_balance": {
            "$ref": "common.json#/$defs/Decimal"
          },
          "available": {
            "$ref": "common.json#/$defs/Decimal"
          },
          "unrealized_pnl": {
            "$ref": "common.json#/$defs/Decimal"
          }
        }
      },
      "PositionRow": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "symbol",
          "product",
          "position_side",
          "qty",
          "entry_price"
        ],
        "properties": {
          "symbol": {
            "$ref": "common.json#/$defs/Symbol"
          },
          "product": {
            "$ref": "common.json#/$defs/Product"
          },
          "position_side": {
            "$ref": "common.json#/$defs/PositionSide"
          },
          "qty": {
            "$ref": "common.json#/$defs/Decimal",
            "description": "one_way 下带符号(空头为负);hedge 下按 position_side 为正"
          },
          "entry_price": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "mark_price": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "unrealized_pnl": {
            "$ref": "common.json#/$defs/Decimal"
          },
          "leverage": {
            "type": "integer",
            "minimum": 1,
            "maximum": 125
          },
          "margin_type": {
            "$ref": "common.json#/$defs/MarginType"
          },
          "isolated_margin": {
            "$ref": "common.json#/$defs/Decimal"
          },
          "liquidation_price": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "notional": {
            "$ref": "common.json#/$defs/Decimal"
          },
          "exchange_update_time": {
            "$ref": "common.json#/$defs/TimestampMs"
          }
        }
      },
      "OrderRow": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "exchange_order_id",
          "symbol",
          "product",
          "side",
          "position_side",
          "order_type",
          "status",
          "orig_qty",
          "executed_qty",
          "reduce_only",
          "origin"
        ],
        "properties": {
          "exchange_order_id": {
            "type": "string",
            "maxLength": 64
          },
          "client_order_id": {
            "$ref": "common.json#/$defs/ClientOrderId"
          },
          "symbol": {
            "$ref": "common.json#/$defs/Symbol"
          },
          "product": {
            "$ref": "common.json#/$defs/Product"
          },
          "side": {
            "$ref": "common.json#/$defs/Side"
          },
          "position_side": {
            "$ref": "common.json#/$defs/PositionSide"
          },
          "order_type": {
            "$ref": "common.json#/$defs/OrderType"
          },
          "status": {
            "$ref": "common.json#/$defs/ExchangeOrderStatus"
          },
          "orig_qty": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "executed_qty": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "avg_price": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "price": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "stop_price": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "reduce_only": {
            "type": "boolean"
          },
          "close_position": {
            "type": "boolean"
          },
          "time_in_force": {
            "$ref": "common.json#/$defs/TimeInForce"
          },
          "working_type": {
            "$ref": "common.json#/$defs/WorkingType"
          },
          "origin": {
            "$ref": "common.json#/$defs/OrderOrigin"
          },
          "exchange_update_time": {
            "$ref": "common.json#/$defs/TimestampMs"
          },
          "exchange_create_time": {
            "$ref": "common.json#/$defs/TimestampMs"
          }
        }
      },
      "FillRow": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "trade_id",
          "exchange_order_id",
          "symbol",
          "product",
          "side",
          "qty",
          "price",
          "trade_time"
        ],
        "properties": {
          "trade_id": {
            "type": "string",
            "maxLength": 64
          },
          "exchange_order_id": {
            "type": "string",
            "maxLength": 64
          },
          "client_order_id": {
            "$ref": "common.json#/$defs/ClientOrderId"
          },
          "symbol": {
            "$ref": "common.json#/$defs/Symbol"
          },
          "product": {
            "$ref": "common.json#/$defs/Product"
          },
          "side": {
            "$ref": "common.json#/$defs/Side"
          },
          "position_side": {
            "$ref": "common.json#/$defs/PositionSide"
          },
          "qty": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "price": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "quote_qty": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "commission": {
            "$ref": "common.json#/$defs/Decimal"
          },
          "commission_asset": {
            "$ref": "common.json#/$defs/Asset"
          },
          "realized_pnl": {
            "$ref": "common.json#/$defs/Decimal"
          },
          "is_maker": {
            "type": "boolean"
          },
          "trade_time": {
            "$ref": "common.json#/$defs/TimestampMs"
          }
        }
      },
      "MarginInfo": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "margin_ratio": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "maintenance_margin": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "margin_balance": {
            "$ref": "common.json#/$defs/Decimal"
          },
          "available_balance": {
            "$ref": "common.json#/$defs/Decimal"
          }
        }
      },
      "BalancesComponent": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "observed_at",
          "fetched_from",
          "fetched_to",
          "completeness",
          "source"
        ],
        "properties": {
          "observed_at": {
            "$ref": "common.json#/$defs/TimestampMs"
          },
          "fetched_from": {
            "$ref": "common.json#/$defs/TimestampMs"
          },
          "fetched_to": {
            "$ref": "common.json#/$defs/TimestampMs"
          },
          "completeness": {
            "$ref": "common.json#/$defs/Completeness"
          },
          "source": {
            "$ref": "common.json#/$defs/ObservationSource"
          },
          "error": {
            "$ref": "common.json#/$defs/ErrorInfo"
          },
          "data": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/BalanceRow"
            }
          }
        }
      },
      "PositionsComponent": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "observed_at",
          "fetched_from",
          "fetched_to",
          "completeness",
          "source"
        ],
        "properties": {
          "observed_at": {
            "$ref": "common.json#/$defs/TimestampMs"
          },
          "fetched_from": {
            "$ref": "common.json#/$defs/TimestampMs"
          },
          "fetched_to": {
            "$ref": "common.json#/$defs/TimestampMs"
          },
          "completeness": {
            "$ref": "common.json#/$defs/Completeness"
          },
          "source": {
            "$ref": "common.json#/$defs/ObservationSource"
          },
          "error": {
            "$ref": "common.json#/$defs/ErrorInfo"
          },
          "data": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/PositionRow"
            }
          }
        }
      },
      "OrdersComponent": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "observed_at",
          "fetched_from",
          "fetched_to",
          "completeness",
          "source"
        ],
        "properties": {
          "observed_at": {
            "$ref": "common.json#/$defs/TimestampMs"
          },
          "fetched_from": {
            "$ref": "common.json#/$defs/TimestampMs"
          },
          "fetched_to": {
            "$ref": "common.json#/$defs/TimestampMs"
          },
          "completeness": {
            "$ref": "common.json#/$defs/Completeness"
          },
          "source": {
            "$ref": "common.json#/$defs/ObservationSource"
          },
          "error": {
            "$ref": "common.json#/$defs/ErrorInfo"
          },
          "data": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/OrderRow"
            }
          }
        }
      },
      "PositionModeComponent": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "observed_at",
          "fetched_from",
          "fetched_to",
          "completeness",
          "source"
        ],
        "properties": {
          "observed_at": {
            "$ref": "common.json#/$defs/TimestampMs"
          },
          "fetched_from": {
            "$ref": "common.json#/$defs/TimestampMs"
          },
          "fetched_to": {
            "$ref": "common.json#/$defs/TimestampMs"
          },
          "completeness": {
            "$ref": "common.json#/$defs/Completeness"
          },
          "source": {
            "$ref": "common.json#/$defs/ObservationSource"
          },
          "error": {
            "$ref": "common.json#/$defs/ErrorInfo"
          },
          "data": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "mode"
            ],
            "properties": {
              "mode": {
                "$ref": "common.json#/$defs/PositionMode"
              }
            }
          }
        }
      },
      "FillsComponent": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "observed_at",
          "fetched_from",
          "fetched_to",
          "completeness",
          "source"
        ],
        "properties": {
          "observed_at": {
            "$ref": "common.json#/$defs/TimestampMs"
          },
          "fetched_from": {
            "$ref": "common.json#/$defs/TimestampMs"
          },
          "fetched_to": {
            "$ref": "common.json#/$defs/TimestampMs"
          },
          "completeness": {
            "$ref": "common.json#/$defs/Completeness"
          },
          "source": {
            "$ref": "common.json#/$defs/ObservationSource"
          },
          "error": {
            "$ref": "common.json#/$defs/ErrorInfo"
          },
          "data": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/FillRow"
            }
          }
        }
      },
      "MarginComponent": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "observed_at",
          "fetched_from",
          "fetched_to",
          "completeness",
          "source"
        ],
        "properties": {
          "observed_at": {
            "$ref": "common.json#/$defs/TimestampMs"
          },
          "fetched_from": {
            "$ref": "common.json#/$defs/TimestampMs"
          },
          "fetched_to": {
            "$ref": "common.json#/$defs/TimestampMs"
          },
          "completeness": {
            "$ref": "common.json#/$defs/Completeness"
          },
          "source": {
            "$ref": "common.json#/$defs/ObservationSource"
          },
          "error": {
            "$ref": "common.json#/$defs/ErrorInfo"
          },
          "data": {
            "$ref": "#/$defs/MarginInfo"
          }
        }
      },
      "AccountSummary": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "quote_asset",
          "wallet_balance",
          "available_balance",
          "unrealized_pnl",
          "open_position_count",
          "open_order_count"
        ],
        "properties": {
          "quote_asset": {
            "$ref": "common.json#/$defs/Asset"
          },
          "wallet_balance": {
            "$ref": "common.json#/$defs/Decimal"
          },
          "margin_balance": {
            "$ref": "common.json#/$defs/Decimal"
          },
          "available_balance": {
            "$ref": "common.json#/$defs/Decimal"
          },
          "unrealized_pnl": {
            "$ref": "common.json#/$defs/Decimal"
          },
          "today_realized_pnl": {
            "$ref": "common.json#/$defs/Decimal"
          },
          "open_position_count": {
            "type": "integer",
            "minimum": 0
          },
          "open_order_count": {
            "type": "integer",
            "minimum": 0
          }
        }
      }
    }
  },
  "attempt": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://trading-swarm.dev/schema/attempt.json",
    "title": "ExecutionAttempt",
    "description": "一次对交易所的写调用(设计 §5.1)。clientOrderId 与完整订单指纹在调用前持久化(stage=before_submit);同 id 重发必须是交易所级幂等,否则不重发;结果 unknown 非终态,由 reconciler 按 clientOrderId 收敛。",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schema_version",
      "attempt_id",
      "intent_id",
      "plan_id",
      "plan_hash",
      "attempt_no",
      "leg",
      "leg_index",
      "account",
      "channel",
      "client_order_id",
      "order_fingerprint",
      "writer_instance_id",
      "lease_epoch",
      "fencing_token",
      "stage",
      "result",
      "created_at",
      "deadline_at"
    ],
    "properties": {
      "schema_version": {
        "$ref": "common.json#/$defs/SchemaVersion"
      },
      "attempt_id": {
        "$ref": "common.json#/$defs/Uuid"
      },
      "intent_id": {
        "$ref": "common.json#/$defs/Uuid"
      },
      "plan_id": {
        "$ref": "common.json#/$defs/Uuid"
      },
      "plan_hash": {
        "$ref": "common.json#/$defs/Hash256"
      },
      "attempt_no": {
        "type": "integer",
        "minimum": 1
      },
      "leg": {
        "$ref": "common.json#/$defs/Leg"
      },
      "leg_index": {
        "type": "integer",
        "minimum": 0,
        "description": "同类腿的序号,如第 2 个止盈腿"
      },
      "account": {
        "$ref": "common.json#/$defs/AccountRef"
      },
      "channel": {
        "$ref": "common.json#/$defs/Channel"
      },
      "client_order_id": {
        "$ref": "common.json#/$defs/ClientOrderId",
        "description": "tg-<intent_id 前 12 hex>-<leg 码 e|s|t|c|x|f>-<attempt_no>;transfer 类放 transfer 的 client tran id"
      },
      "order_fingerprint": {
        "type": "string",
        "maxLength": 1024,
        "description": "canonical_json(实际发送给交易所的参数,脱敏)——对账时与交易所回显逐字比对"
      },
      "writer_instance_id": {
        "type": "string",
        "maxLength": 128
      },
      "lease_epoch": {
        "type": "integer",
        "minimum": 0
      },
      "fencing_token": {
        "type": "string",
        "maxLength": 128
      },
      "stage": {
        "$ref": "common.json#/$defs/AttemptStage"
      },
      "result": {
        "$ref": "common.json#/$defs/AttemptResult"
      },
      "created_at": {
        "$ref": "common.json#/$defs/TimestampMs"
      },
      "submitted_at": {
        "$ref": "common.json#/$defs/TimestampMs"
      },
      "deadline_at": {
        "$ref": "common.json#/$defs/TimestampMs",
        "description": "调用截止;超过仍无结果 → result=unknown"
      },
      "result_at": {
        "$ref": "common.json#/$defs/TimestampMs"
      },
      "exchange_order_id": {
        "type": "string",
        "maxLength": 64
      },
      "exchange_ref": {
        "type": "string",
        "maxLength": 128,
        "description": "非订单类效果的交易所引用,如 transfer 的 tranId"
      },
      "error": {
        "$ref": "common.json#/$defs/ErrorInfo"
      },
      "tool_name": {
        "type": "string",
        "maxLength": 128,
        "description": "MCP 通道:实际调用的工具名(来自钉版快照)"
      },
      "tools_hash": {
        "$ref": "common.json#/$defs/Hash256",
        "description": "MCP 通道:调用时的 tools/list 快照哈希(漂移守卫)"
      }
    }
  },
  "authorization": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://trading-swarm.dev/schema/authorization.json",
    "title": "Authorization",
    "description": "对某个 plan_hash 的授权(设计 §5.1)。by=user 需要 confirm_echo(结构化确认:审批面逐字回填关键字段,execd 与 plan 派生的 confirm_fields 逐字比对);by=policy 只在 LiveCapped 且上限内出现(v1 feature-gate 关闭)。",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schema_version",
      "authorization_id",
      "intent_id",
      "plan_id",
      "plan_hash",
      "by",
      "status",
      "granted_at",
      "expires_at"
    ],
    "properties": {
      "schema_version": {
        "$ref": "common.json#/$defs/SchemaVersion"
      },
      "authorization_id": {
        "$ref": "common.json#/$defs/Uuid"
      },
      "intent_id": {
        "$ref": "common.json#/$defs/Uuid"
      },
      "plan_id": {
        "$ref": "common.json#/$defs/Uuid"
      },
      "plan_hash": {
        "$ref": "common.json#/$defs/Hash256"
      },
      "by": {
        "type": "string",
        "enum": [
          "user",
          "policy"
        ]
      },
      "principal": {
        "$ref": "common.json#/$defs/Principal"
      },
      "surface": {
        "$ref": "common.json#/$defs/Surface"
      },
      "actor_ref": {
        "type": "string",
        "maxLength": 256,
        "description": "谁批的:设备/会话/RPC 连接标识;by=policy 时为 policy 版本"
      },
      "status": {
        "$ref": "common.json#/$defs/AuthorizationStatus"
      },
      "status_reason": {
        "type": "string",
        "maxLength": 1000
      },
      "confirm_echo": {
        "type": "object",
        "additionalProperties": {
          "type": "string",
          "maxLength": 200
        },
        "description": "审批面回填的字段(见 docs/contracts/README.md「confirm_fields」);by=user 必填"
      },
      "granted_at": {
        "$ref": "common.json#/$defs/TimestampMs"
      },
      "expires_at": {
        "$ref": "common.json#/$defs/TimestampMs"
      },
      "consumed_at": {
        "$ref": "common.json#/$defs/TimestampMs"
      },
      "consumed_by_attempt_id": {
        "$ref": "common.json#/$defs/Uuid"
      }
    },
    "if": {
      "properties": {
        "by": {
          "const": "user"
        }
      },
      "required": [
        "by"
      ]
    },
    "then": {
      "required": [
        "confirm_echo",
        "principal",
        "surface"
      ]
    }
  },
  "common": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://trading-swarm.dev/schema/common.json",
    "title": "Common",
    "description": "所有契约共享的基础类型。金额/价格/数量一律十进制字符串,时间戳一律 unix 毫秒整数,枚举一律小写 snake_case。",
    "$defs": {
      "Uuid": {
        "type": "string",
        "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
        "description": "小写 UUID(v4 为主)"
      },
      "Decimal": {
        "type": "string",
        "pattern": "^-?(0|[1-9][0-9]*)(\\.[0-9]+)?$",
        "description": "十进制字符串;不用 float,便于两种语言得到相同的 canonical JSON 与哈希"
      },
      "UnsignedDecimal": {
        "type": "string",
        "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]+)?$"
      },
      "TimestampMs": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991,
        "description": "unix 毫秒;上限为 JS 安全整数"
      },
      "Hash256": {
        "type": "string",
        "pattern": "^[0-9a-f]{64}$",
        "description": "sha256 小写 hex"
      },
      "Symbol": {
        "type": "string",
        "pattern": "^[A-Z0-9]{2,20}$",
        "description": "交易所符号,如 BTCUSDT"
      },
      "Asset": {
        "type": "string",
        "pattern": "^[A-Z0-9]{1,12}$"
      },
      "ClientOrderId": {
        "type": "string",
        "pattern": "^[\\.A-Z:/a-z0-9_-]{1,36}$",
        "description": "Binance 允许的 clientOrderId 字符集与长度;本仓库生成的以 tg- 开头"
      },
      "AccountRef": {
        "type": "string",
        "enum": [
          "main",
          "sub"
        ],
        "description": "main=主账户(用户,REST);sub=Agentic 子账户(agent,MCP)"
      },
      "Channel": {
        "type": "string",
        "enum": [
          "rest",
          "mcp"
        ]
      },
      "ObservationSource": {
        "type": "string",
        "enum": [
          "rest",
          "ws",
          "mcp",
          "cache"
        ]
      },
      "Product": {
        "type": "string",
        "enum": [
          "usdm_perp",
          "spot"
        ],
        "description": "v1:USDⓈ-M 永续可交易;spot 只读"
      },
      "Side": {
        "type": "string",
        "enum": [
          "buy",
          "sell"
        ]
      },
      "PositionSide": {
        "type": "string",
        "enum": [
          "both",
          "long",
          "short"
        ]
      },
      "PositionMode": {
        "type": "string",
        "enum": [
          "one_way",
          "hedge"
        ]
      },
      "MarginType": {
        "type": "string",
        "enum": [
          "isolated",
          "cross"
        ]
      },
      "OrderType": {
        "type": "string",
        "enum": [
          "market",
          "limit",
          "stop_market",
          "stop_limit",
          "take_profit_market",
          "take_profit_limit",
          "trailing_stop_market"
        ]
      },
      "TimeInForce": {
        "type": "string",
        "enum": [
          "gtc",
          "ioc",
          "fok",
          "gtx"
        ]
      },
      "WorkingType": {
        "type": "string",
        "enum": [
          "mark_price",
          "contract_price"
        ],
        "description": "条件单触发价来源:mark=标记价,contract=最新成交价"
      },
      "Wallet": {
        "type": "string",
        "enum": [
          "spot",
          "usdm_futures"
        ]
      },
      "Principal": {
        "type": "string",
        "enum": [
          "user",
          "model",
          "cron",
          "scheduler",
          "mcp_client"
        ],
        "description": "ActorContext.principal(设计 §6.1)"
      },
      "Surface": {
        "type": "string",
        "enum": [
          "rpc",
          "model",
          "mcp",
          "internal"
        ]
      },
      "IntentKind": {
        "type": "string",
        "enum": [
          "open",
          "close",
          "cancel_order",
          "protect",
          "transfer"
        ]
      },
      "IntentStatus": {
        "type": "string",
        "enum": [
          "proposed",
          "rejected",
          "awaiting_approval",
          "authorized",
          "recorded",
          "dispatching",
          "execution_unknown",
          "executing",
          "completed",
          "canceled",
          "expired"
        ],
        "description": "设计 §5.1 状态图;终态 rejected/recorded/completed/canceled/expired;execution_unknown 非终态"
      },
      "AuthorizationStatus": {
        "type": "string",
        "enum": [
          "active",
          "consumed",
          "expired",
          "invalidated",
          "revoked"
        ]
      },
      "AttemptStage": {
        "type": "string",
        "enum": [
          "before_submit",
          "submitted",
          "result_persisted"
        ],
        "description": "崩溃边界:clientOrderId 在 before_submit 时已持久化;submitted 后不知结果即 unknown"
      },
      "AttemptResult": {
        "type": "string",
        "enum": [
          "pending",
          "acked",
          "rejected",
          "unknown",
          "not_received"
        ]
      },
      "ExchangeOrderStatus": {
        "type": "string",
        "enum": [
          "new",
          "partially_filled",
          "filled",
          "canceled",
          "expired",
          "rejected"
        ]
      },
      "EffectStatus": {
        "type": "string",
        "enum": [
          "pending",
          "satisfied",
          "failed"
        ]
      },
      "Leg": {
        "type": "string",
        "enum": [
          "entry",
          "stop",
          "take_profit",
          "cancel",
          "close",
          "transfer"
        ],
        "description": "一个 intent 可能产生多条腿;每条腿各自有 ExecutionAttempt"
      },
      "OrderOrigin": {
        "type": "string",
        "enum": [
          "local",
          "foreign",
          "unknown"
        ],
        "description": "按 clientOrderId 前缀判定:tg- 为本机;其他(含 外部系统的 ts_)为外部"
      },
      "Completeness": {
        "type": "string",
        "enum": [
          "complete",
          "partial",
          "missing"
        ]
      },
      "Consistency": {
        "type": "string",
        "enum": [
          "consistent",
          "inconsistent",
          "unavailable"
        ]
      },
      "PolicyMode": {
        "type": "string",
        "enum": [
          "run",
          "stop_opening",
          "flatten_only",
          "halt_all"
        ]
      },
      "Authority": {
        "type": "string",
        "enum": [
          "observe",
          "draft",
          "paper",
          "live_capped"
        ]
      },
      "ErrorKind": {
        "type": "string",
        "enum": [
          "invalid_params",
          "not_found",
          "forbidden",
          "halted",
          "stale",
          "unavailable",
          "conflict",
          "expired",
          "invalid_transition",
          "gate_rejected",
          "exchange_rejected",
          "unauthorized",
          "rate_limited",
          "transport_ambiguous",
          "internal"
        ]
      },
      "ErrorInfo": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "kind",
          "message",
          "retryable"
        ],
        "properties": {
          "kind": {
            "$ref": "#/$defs/ErrorKind"
          },
          "message": {
            "type": "string",
            "maxLength": 2000
          },
          "retryable": {
            "type": "boolean"
          },
          "exchange_code": {
            "type": "integer",
            "description": "交易所错误码(如 Binance -2021),有则带"
          },
          "http_status": {
            "type": "integer",
            "minimum": 100,
            "maximum": 599
          }
        }
      },
      "GateRejection": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "gate",
          "message"
        ],
        "properties": {
          "gate": {
            "type": "string",
            "pattern": "^[a-z][a-z0-9_.]{1,63}$",
            "description": "闸名,如 policy.mode / freshness.account / risk.max_leverage"
          },
          "value": {
            "type": "string",
            "maxLength": 200,
            "description": "被拒时的实际值(字符串化)"
          },
          "limit": {
            "type": "string",
            "maxLength": 200,
            "description": "阈值(字符串化)"
          },
          "message": {
            "type": "string",
            "maxLength": 1000
          }
        }
      },
      "SchemaVersion": {
        "type": "integer",
        "const": 1
      }
    }
  },
  "demo_portfolio_capacity": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://trading-swarm.dev/schema/demo_portfolio_capacity.json",
    "title": "DemoPortfolioCapacity",
    "description": "Portfolio Manager 典型止损容量估算；不是执行授权。金额为十进制字符串，不能计算的字段显式 null。",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schema_version",
      "snapshot_id",
      "computed_at",
      "basis",
      "snapshot_quality",
      "equity",
      "available",
      "risk_pct",
      "leverage",
      "default_stop_distance_pct",
      "slots_total",
      "slots_used",
      "slots_free",
      "margin_budget",
      "binding_constraint",
      "by_symbol"
    ],
    "properties": {
      "schema_version": {
        "const": 1
      },
      "snapshot_id": {
        "type": "string"
      },
      "computed_at": {
        "type": "integer",
        "minimum": 0
      },
      "basis": {
        "const": "typical_stop_estimate"
      },
      "snapshot_quality": {
        "enum": [
          "ok",
          "stale",
          "inconsistent",
          "incomplete"
        ]
      },
      "equity": {
        "anyOf": [
          {
            "type": "string",
            "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]+)?$"
          },
          {
            "type": "null"
          }
        ]
      },
      "available": {
        "anyOf": [
          {
            "type": "string",
            "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]+)?$"
          },
          {
            "type": "null"
          }
        ]
      },
      "risk_pct": {
        "type": "string",
        "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]+)?$"
      },
      "leverage": {
        "type": "number",
        "exclusiveMinimum": 0
      },
      "default_stop_distance_pct": {
        "type": "string",
        "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]+)?$"
      },
      "slots_total": {
        "type": "integer",
        "minimum": 0
      },
      "slots_used": {
        "type": "integer",
        "minimum": 0
      },
      "slots_free": {
        "type": "integer",
        "minimum": 0
      },
      "margin_budget": {
        "$ref": "#/$defs/DemoCapacityMargin"
      },
      "binding_constraint": {
        "$ref": "#/$defs/DemoCapacityConstraint"
      },
      "by_symbol": {
        "type": "array",
        "items": {
          "$ref": "#/$defs/DemoSymbolCapacity"
        }
      }
    },
    "$defs": {
      "DemoCapacityConstraint": {
        "enum": [
          "thread_slots",
          "margin_budget",
          "available_margin",
          "min_size_risk",
          "rules_unknown",
          "market_unavailable",
          "watchlist",
          "snapshot_unavailable"
        ]
      },
      "DemoCapacityMargin": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "max_margin_ratio",
          "limit_usdt",
          "committed_usdt",
          "reserved_usdt",
          "free_usdt",
          "required_for_free_slots_usdt",
          "slots_supported",
          "witness_symbols"
        ],
        "properties": {
          "max_margin_ratio": {
            "type": "number",
            "exclusiveMinimum": 0,
            "maximum": 1
          },
          "limit_usdt": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]+)?$"
              },
              {
                "type": "null"
              }
            ]
          },
          "committed_usdt": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]+)?$"
              },
              {
                "type": "null"
              }
            ]
          },
          "reserved_usdt": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]+)?$"
              },
              {
                "type": "null"
              }
            ]
          },
          "free_usdt": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]+)?$"
              },
              {
                "type": "null"
              }
            ]
          },
          "required_for_free_slots_usdt": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]+)?$"
              },
              {
                "type": "null"
              }
            ]
          },
          "slots_supported": {
            "type": [
              "integer",
              "null"
            ],
            "minimum": 0
          },
          "witness_symbols": {
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        }
      },
      "DemoSymbolCapacity": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "symbol",
          "verdict",
          "watch_only",
          "occupied",
          "price",
          "rules_source",
          "rules_observed_at",
          "stop_distance_pct",
          "stop_source",
          "min_qty",
          "min_viable_notional",
          "min_size_risk",
          "required_equity",
          "equity_shortfall",
          "margin_per_thread",
          "risk_budget",
          "budget_margin_per_thread"
        ],
        "properties": {
          "symbol": {
            "type": "string"
          },
          "verdict": {
            "enum": [
              "ok",
              "needs_equity",
              "rules_unknown",
              "unavailable"
            ]
          },
          "watch_only": {
            "type": "boolean"
          },
          "occupied": {
            "type": "boolean"
          },
          "price": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]+)?$"
              },
              {
                "type": "null"
              }
            ]
          },
          "rules_source": {
            "enum": [
              "exchange",
              "paper",
              null
            ]
          },
          "rules_observed_at": {
            "type": [
              "integer",
              "null"
            ],
            "minimum": 0
          },
          "stop_distance_pct": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]+)?$"
              },
              {
                "type": "null"
              }
            ]
          },
          "stop_source": {
            "enum": [
              "atr",
              "default",
              null
            ]
          },
          "min_qty": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]+)?$"
              },
              {
                "type": "null"
              }
            ]
          },
          "min_viable_notional": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]+)?$"
              },
              {
                "type": "null"
              }
            ]
          },
          "min_size_risk": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]+)?$"
              },
              {
                "type": "null"
              }
            ]
          },
          "required_equity": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]+)?$"
              },
              {
                "type": "null"
              }
            ]
          },
          "equity_shortfall": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]+)?$"
              },
              {
                "type": "null"
              }
            ]
          },
          "margin_per_thread": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]+)?$"
              },
              {
                "type": "null"
              }
            ]
          },
          "risk_budget": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]+)?$"
              },
              {
                "type": "null"
              }
            ]
          },
          "budget_margin_per_thread": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^(0|[1-9][0-9]*)(\\.[0-9]+)?$"
              },
              {
                "type": "null"
              }
            ]
          }
        }
      }
    }
  },
  "events": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://trading-swarm.dev/schema/events.json",
    "title": "ExecEvent",
    "description": "execd 发出的事件(UDS 通知 exec.event,同时落 exec.sqlite events 表,seq 单调,支持 since_seq 回放)。gateway 把它桥接到自己的事件总线与 events 表——'事件即审计'口径(设计 §4)。",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schema_version",
      "seq",
      "event",
      "at",
      "payload"
    ],
    "properties": {
      "schema_version": {
        "$ref": "common.json#/$defs/SchemaVersion"
      },
      "seq": {
        "type": "integer",
        "minimum": 1
      },
      "event": {
        "$ref": "#/$defs/EventName"
      },
      "at": {
        "$ref": "common.json#/$defs/TimestampMs"
      },
      "account": {
        "$ref": "common.json#/$defs/AccountRef"
      },
      "intent_id": {
        "$ref": "common.json#/$defs/Uuid"
      },
      "plan_id": {
        "$ref": "common.json#/$defs/Uuid"
      },
      "attempt_id": {
        "$ref": "common.json#/$defs/Uuid"
      },
      "symbol": {
        "$ref": "common.json#/$defs/Symbol"
      },
      "payload": {
        "type": "object",
        "description": "事件专属载荷(通常是对应记录本身或其差分)"
      }
    },
    "$defs": {
      "EventName": {
        "type": "string",
        "enum": [
          "intent.created",
          "intent.rejected",
          "intent.awaiting_approval",
          "intent.authorized",
          "intent.recorded",
          "intent.dispatching",
          "intent.executing",
          "intent.execution_unknown",
          "intent.completed",
          "intent.canceled",
          "intent.expired",
          "plan.materialized",
          "authorization.granted",
          "authorization.consumed",
          "authorization.invalidated",
          "authorization.expired",
          "authorization.revoked",
          "attempt.submitting",
          "attempt.submitted",
          "attempt.resolved",
          "order.observed",
          "fill.observed",
          "effect.evaluated",
          "protection.confirmed",
          "protection.missing",
          "protection.compensated",
          "account.updated",
          "account.stale",
          "account.inconsistent",
          "foreign_activity.detected",
          "exchange.auth.expiring",
          "exchange.auth.expired",
          "exchange.auth.revoked",
          "exchange.auth.refreshed",
          "exchange.tools.drift",
          "exchange.channel.degraded",
          "exchange.channel.recovered",
          "policy.changed",
          "halt.changed",
          "writer.fenced",
          "corruption.detected",
          "health"
        ]
      }
    }
  },
  "exchange_order": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://trading-swarm.dev/schema/exchange_order.json",
    "title": "ExchangeOrderObservation",
    "description": "交易所订单的观察值(设计 §5.1):不可变、按 observed_at 追加;订单状态从最新观察派生。同一 exchange_order_id 的观察序列必须满足 transitions/exchange_order_status.json 的单调性,否则标 ORDER_STATE_UNKNOWN。",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schema_version",
      "observation_id",
      "account",
      "channel",
      "source",
      "product",
      "symbol",
      "exchange_order_id",
      "status",
      "side",
      "position_side",
      "order_type",
      "orig_qty",
      "executed_qty",
      "reduce_only",
      "origin",
      "observed_at"
    ],
    "properties": {
      "schema_version": {
        "$ref": "common.json#/$defs/SchemaVersion"
      },
      "observation_id": {
        "$ref": "common.json#/$defs/Uuid"
      },
      "account": {
        "$ref": "common.json#/$defs/AccountRef"
      },
      "channel": {
        "$ref": "common.json#/$defs/Channel"
      },
      "source": {
        "$ref": "common.json#/$defs/ObservationSource"
      },
      "product": {
        "$ref": "common.json#/$defs/Product"
      },
      "symbol": {
        "$ref": "common.json#/$defs/Symbol"
      },
      "exchange_order_id": {
        "type": "string",
        "maxLength": 64
      },
      "client_order_id": {
        "$ref": "common.json#/$defs/ClientOrderId"
      },
      "status": {
        "$ref": "common.json#/$defs/ExchangeOrderStatus"
      },
      "side": {
        "$ref": "common.json#/$defs/Side"
      },
      "position_side": {
        "$ref": "common.json#/$defs/PositionSide"
      },
      "order_type": {
        "$ref": "common.json#/$defs/OrderType"
      },
      "orig_qty": {
        "$ref": "common.json#/$defs/UnsignedDecimal"
      },
      "executed_qty": {
        "$ref": "common.json#/$defs/UnsignedDecimal"
      },
      "avg_price": {
        "$ref": "common.json#/$defs/UnsignedDecimal"
      },
      "price": {
        "$ref": "common.json#/$defs/UnsignedDecimal"
      },
      "stop_price": {
        "$ref": "common.json#/$defs/UnsignedDecimal"
      },
      "cum_quote": {
        "$ref": "common.json#/$defs/UnsignedDecimal"
      },
      "reduce_only": {
        "type": "boolean"
      },
      "close_position": {
        "type": "boolean"
      },
      "time_in_force": {
        "$ref": "common.json#/$defs/TimeInForce"
      },
      "working_type": {
        "$ref": "common.json#/$defs/WorkingType"
      },
      "origin": {
        "$ref": "common.json#/$defs/OrderOrigin"
      },
      "attempt_id": {
        "$ref": "common.json#/$defs/Uuid",
        "description": "按 client_order_id 归属到的本机 attempt;foreign 订单为空"
      },
      "exchange_update_time": {
        "$ref": "common.json#/$defs/TimestampMs"
      },
      "exchange_create_time": {
        "$ref": "common.json#/$defs/TimestampMs"
      },
      "observed_at": {
        "$ref": "common.json#/$defs/TimestampMs"
      },
      "raw_hash": {
        "$ref": "common.json#/$defs/Hash256",
        "description": "原始交易所响应的 sha256(原文按保留策略另存)"
      }
    }
  },
  "fill": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://trading-swarm.dev/schema/fill.json",
    "title": "Fill",
    "description": "成交观察值(设计 §5.1),不可变;(account, exchange_order_id, trade_id) 唯一。",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schema_version",
      "fill_id",
      "account",
      "channel",
      "source",
      "product",
      "symbol",
      "exchange_order_id",
      "trade_id",
      "side",
      "qty",
      "price",
      "trade_time",
      "observed_at"
    ],
    "properties": {
      "schema_version": {
        "$ref": "common.json#/$defs/SchemaVersion"
      },
      "fill_id": {
        "$ref": "common.json#/$defs/Uuid"
      },
      "account": {
        "$ref": "common.json#/$defs/AccountRef"
      },
      "channel": {
        "$ref": "common.json#/$defs/Channel"
      },
      "source": {
        "$ref": "common.json#/$defs/ObservationSource"
      },
      "product": {
        "$ref": "common.json#/$defs/Product"
      },
      "symbol": {
        "$ref": "common.json#/$defs/Symbol"
      },
      "exchange_order_id": {
        "type": "string",
        "maxLength": 64
      },
      "trade_id": {
        "type": "string",
        "maxLength": 64
      },
      "client_order_id": {
        "$ref": "common.json#/$defs/ClientOrderId"
      },
      "attempt_id": {
        "$ref": "common.json#/$defs/Uuid"
      },
      "side": {
        "$ref": "common.json#/$defs/Side"
      },
      "position_side": {
        "$ref": "common.json#/$defs/PositionSide"
      },
      "qty": {
        "$ref": "common.json#/$defs/UnsignedDecimal"
      },
      "price": {
        "$ref": "common.json#/$defs/UnsignedDecimal"
      },
      "quote_qty": {
        "$ref": "common.json#/$defs/UnsignedDecimal"
      },
      "commission": {
        "$ref": "common.json#/$defs/Decimal"
      },
      "commission_asset": {
        "$ref": "common.json#/$defs/Asset"
      },
      "realized_pnl": {
        "$ref": "common.json#/$defs/Decimal"
      },
      "is_maker": {
        "type": "boolean"
      },
      "trade_time": {
        "$ref": "common.json#/$defs/TimestampMs"
      },
      "observed_at": {
        "$ref": "common.json#/$defs/TimestampMs"
      }
    }
  },
  "intent": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://trading-swarm.dev/schema/intent.json",
    "title": "Intent",
    "description": "动钱的唯一提议记录(设计 §5.1)。模型/UI/Exit DSL 只能提议;经济字段在 ExecutableOrderPlan 里物化并哈希;状态只按 transitions/intent_status.json 迁移。",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schema_version",
      "intent_id",
      "account",
      "principal",
      "surface",
      "params",
      "status",
      "gate_rejections",
      "ttl_seconds",
      "created_at",
      "updated_at"
    ],
    "properties": {
      "schema_version": {
        "$ref": "common.json#/$defs/SchemaVersion"
      },
      "intent_id": {
        "$ref": "common.json#/$defs/Uuid"
      },
      "account": {
        "$ref": "common.json#/$defs/AccountRef",
        "description": "效果落在哪个账户;transfer 类以 from_account 为 lane"
      },
      "principal": {
        "$ref": "common.json#/$defs/Principal"
      },
      "surface": {
        "$ref": "common.json#/$defs/Surface"
      },
      "session_id": {
        "type": "string",
        "maxLength": 128
      },
      "run_id": {
        "type": "string",
        "maxLength": 128
      },
      "origin": {
        "type": "string",
        "maxLength": 256,
        "description": "来源说明,如 recipe:w4-judgment / ui:trade-page / exit-dsl:thread-42"
      },
      "idempotency_key": {
        "type": "string",
        "maxLength": 128,
        "description": "提议方幂等键;execd 按 (principal, idempotency_key) 去重,同键不同内容 = corruption"
      },
      "params": {
        "$ref": "#/$defs/IntentParams"
      },
      "status": {
        "$ref": "common.json#/$defs/IntentStatus"
      },
      "status_reason": {
        "type": "string",
        "maxLength": 1000
      },
      "gate_rejections": {
        "type": "array",
        "items": {
          "$ref": "common.json#/$defs/GateRejection"
        },
        "description": "每次闸拒都追加,不覆盖"
      },
      "current_plan_id": {
        "$ref": "common.json#/$defs/Uuid"
      },
      "authorization_id": {
        "$ref": "common.json#/$defs/Uuid"
      },
      "ttl_seconds": {
        "type": "integer",
        "minimum": 1,
        "maximum": 86400,
        "description": "提议有效期;到期未进入 authorized 即 expired"
      },
      "created_at": {
        "$ref": "common.json#/$defs/TimestampMs"
      },
      "updated_at": {
        "$ref": "common.json#/$defs/TimestampMs"
      },
      "expires_at": {
        "$ref": "common.json#/$defs/TimestampMs"
      },
      "terminal_at": {
        "$ref": "common.json#/$defs/TimestampMs"
      }
    },
    "$defs": {
      "IntentParams": {
        "oneOf": [
          {
            "$ref": "#/$defs/OpenParams"
          },
          {
            "$ref": "#/$defs/CloseParams"
          },
          {
            "$ref": "#/$defs/CancelOrderParams"
          },
          {
            "$ref": "#/$defs/ProtectParams"
          },
          {
            "$ref": "#/$defs/TransferParams"
          }
        ]
      },
      "SizeSpec": {
        "oneOf": [
          {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "mode",
              "hint"
            ],
            "properties": {
              "mode": {
                "const": "hint"
              },
              "hint": {
                "type": "string",
                "enum": [
                  "full",
                  "half",
                  "quarter"
                ],
                "description": "模型只给档位;qty 由代码按止损距离与风险预算反推"
              }
            }
          },
          {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "mode",
              "qty"
            ],
            "properties": {
              "mode": {
                "const": "qty"
              },
              "qty": {
                "$ref": "common.json#/$defs/UnsignedDecimal"
              }
            }
          },
          {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "mode",
              "notional"
            ],
            "properties": {
              "mode": {
                "const": "notional"
              },
              "notional": {
                "$ref": "common.json#/$defs/UnsignedDecimal",
                "description": "计价币名义(USDT)"
              }
            }
          }
        ]
      },
      "EntrySpec": {
        "oneOf": [
          {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "type"
            ],
            "properties": {
              "type": {
                "const": "market"
              },
              "max_slippage_bps": {
                "type": "integer",
                "minimum": 0,
                "maximum": 10000
              }
            }
          },
          {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "type",
              "price"
            ],
            "properties": {
              "type": {
                "const": "limit"
              },
              "price": {
                "$ref": "common.json#/$defs/UnsignedDecimal"
              },
              "time_in_force": {
                "$ref": "common.json#/$defs/TimeInForce"
              },
              "post_only": {
                "type": "boolean"
              }
            }
          }
        ]
      },
      "StopRef": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "price",
          "trigger"
        ],
        "properties": {
          "price": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "trigger": {
            "$ref": "common.json#/$defs/WorkingType"
          }
        }
      },
      "TakeProfitSpec": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "price",
          "pct"
        ],
        "properties": {
          "price": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "pct": {
            "$ref": "common.json#/$defs/UnsignedDecimal",
            "description": "占仓位百分比 (0,100]"
          },
          "trigger": {
            "$ref": "common.json#/$defs/WorkingType"
          }
        }
      },
      "OrderRef": {
        "type": "object",
        "additionalProperties": false,
        "minProperties": 1,
        "properties": {
          "exchange_order_id": {
            "type": "string",
            "maxLength": 64
          },
          "client_order_id": {
            "$ref": "common.json#/$defs/ClientOrderId"
          }
        }
      },
      "OpenParams": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "kind",
          "product",
          "symbol",
          "side",
          "size",
          "entry",
          "stop",
          "evidence_refs"
        ],
        "properties": {
          "kind": {
            "const": "open"
          },
          "product": {
            "$ref": "common.json#/$defs/Product"
          },
          "symbol": {
            "$ref": "common.json#/$defs/Symbol"
          },
          "side": {
            "$ref": "common.json#/$defs/Side"
          },
          "position_side": {
            "$ref": "common.json#/$defs/PositionSide"
          },
          "size": {
            "$ref": "#/$defs/SizeSpec"
          },
          "entry": {
            "$ref": "#/$defs/EntrySpec"
          },
          "stop": {
            "$ref": "#/$defs/StopRef",
            "description": "开仓必须带止损(设计 §5.4 保护腿协议)"
          },
          "take_profits": {
            "type": "array",
            "maxItems": 4,
            "items": {
              "$ref": "#/$defs/TakeProfitSpec"
            }
          },
          "leverage": {
            "type": "integer",
            "minimum": 1,
            "maximum": 125
          },
          "margin_type": {
            "$ref": "common.json#/$defs/MarginType"
          },
          "thesis": {
            "type": "string",
            "maxLength": 2000
          },
          "evidence_refs": {
            "type": "array",
            "items": {
              "type": "string",
              "maxLength": 64
            },
            "description": "必须 ⊆ 本轮/上一轮 evidence registry(设计 §7.3);用户手动单可为空数组"
          },
          "invalidation": {
            "type": "string",
            "maxLength": 1000
          }
        }
      },
      "CloseParams": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "kind",
          "product",
          "symbol",
          "pct",
          "order"
        ],
        "properties": {
          "kind": {
            "const": "close"
          },
          "product": {
            "$ref": "common.json#/$defs/Product"
          },
          "symbol": {
            "$ref": "common.json#/$defs/Symbol"
          },
          "position_side": {
            "$ref": "common.json#/$defs/PositionSide"
          },
          "pct": {
            "$ref": "common.json#/$defs/UnsignedDecimal",
            "description": "平掉当前持仓的百分比 (0,100];reduce-only,不得翻仓"
          },
          "order": {
            "$ref": "#/$defs/EntrySpec"
          },
          "reason": {
            "type": "string",
            "maxLength": 1000
          },
          "evidence_refs": {
            "type": "array",
            "items": {
              "type": "string",
              "maxLength": 64
            }
          }
        }
      },
      "CancelOrderParams": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "kind",
          "product",
          "symbol",
          "order_ref"
        ],
        "properties": {
          "kind": {
            "const": "cancel_order"
          },
          "product": {
            "$ref": "common.json#/$defs/Product"
          },
          "symbol": {
            "$ref": "common.json#/$defs/Symbol"
          },
          "order_ref": {
            "$ref": "#/$defs/OrderRef"
          },
          "reason": {
            "type": "string",
            "maxLength": 1000
          }
        }
      },
      "ProtectParams": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "kind",
          "product",
          "symbol",
          "replace"
        ],
        "properties": {
          "kind": {
            "const": "protect"
          },
          "product": {
            "$ref": "common.json#/$defs/Product"
          },
          "symbol": {
            "$ref": "common.json#/$defs/Symbol"
          },
          "position_side": {
            "$ref": "common.json#/$defs/PositionSide"
          },
          "stop": {
            "$ref": "#/$defs/StopRef"
          },
          "take_profits": {
            "type": "array",
            "maxItems": 4,
            "items": {
              "$ref": "#/$defs/TakeProfitSpec"
            }
          },
          "replace": {
            "type": "boolean",
            "description": "true=撤掉本机已有保护腿后重挂;false=只补缺"
          },
          "reason": {
            "type": "string",
            "maxLength": 1000
          }
        }
      },
      "TransferParams": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "kind",
          "asset",
          "amount",
          "from_account",
          "from_wallet",
          "to_account",
          "to_wallet"
        ],
        "properties": {
          "kind": {
            "const": "transfer"
          },
          "asset": {
            "$ref": "common.json#/$defs/Asset"
          },
          "amount": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "from_account": {
            "$ref": "common.json#/$defs/AccountRef"
          },
          "from_wallet": {
            "$ref": "common.json#/$defs/Wallet"
          },
          "to_account": {
            "$ref": "common.json#/$defs/AccountRef"
          },
          "to_wallet": {
            "$ref": "common.json#/$defs/Wallet"
          },
          "reason": {
            "type": "string",
            "maxLength": 1000
          }
        },
        "description": "只允许 principal=user 且 surface=rpc;agent 没有任何划转工具(设计 §3.5)。提币不在 v1 契约内(§16 Q7,延后 + IP 白名单)。"
      }
    }
  },
  "plan": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://trading-swarm.dev/schema/plan.json",
    "title": "ExecutableOrderPlan",
    "description": "审批前物化的可执行计划(设计 §5.1)。审批绑定的是 plan_hash = sha256(canonical_json(economic));basis 不进哈希。重闸只能拒绝,不能改 economic;经济字段实质变化 → 新 plan(version+1)+ 作废旧授权。",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schema_version",
      "plan_id",
      "intent_id",
      "version",
      "plan_hash",
      "account",
      "channel",
      "economic",
      "basis",
      "authorization_ttl_seconds",
      "created_at",
      "expires_at"
    ],
    "properties": {
      "schema_version": {
        "$ref": "common.json#/$defs/SchemaVersion"
      },
      "plan_id": {
        "$ref": "common.json#/$defs/Uuid"
      },
      "intent_id": {
        "$ref": "common.json#/$defs/Uuid"
      },
      "version": {
        "type": "integer",
        "minimum": 1
      },
      "plan_hash": {
        "$ref": "common.json#/$defs/Hash256"
      },
      "account": {
        "$ref": "common.json#/$defs/AccountRef"
      },
      "channel": {
        "$ref": "common.json#/$defs/Channel"
      },
      "economic": {
        "$ref": "#/$defs/PlanEconomics"
      },
      "basis": {
        "$ref": "#/$defs/PlanBasis"
      },
      "authorization_ttl_seconds": {
        "type": "integer",
        "minimum": 5,
        "maximum": 3600,
        "description": "授权有效期:市价 30s / 限价 120s(设计 §10.3)"
      },
      "created_at": {
        "$ref": "common.json#/$defs/TimestampMs"
      },
      "expires_at": {
        "$ref": "common.json#/$defs/TimestampMs"
      }
    },
    "$defs": {
      "PlanEconomics": {
        "oneOf": [
          {
            "$ref": "#/$defs/OrderEconomics"
          },
          {
            "$ref": "#/$defs/ProtectEconomics"
          },
          {
            "$ref": "#/$defs/CancelEconomics"
          },
          {
            "$ref": "#/$defs/TransferEconomics"
          }
        ]
      },
      "ProtectionLeg": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "order_type",
          "trigger_price",
          "working_type",
          "close_position"
        ],
        "properties": {
          "order_type": {
            "type": "string",
            "enum": [
              "stop_market",
              "stop_limit",
              "take_profit_market",
              "take_profit_limit"
            ]
          },
          "trigger_price": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "price": {
            "$ref": "common.json#/$defs/UnsignedDecimal",
            "description": "*_limit 类的委托价"
          },
          "qty": {
            "$ref": "common.json#/$defs/UnsignedDecimal",
            "description": "close_position=false 时必填;true 时不填(全平)"
          },
          "working_type": {
            "$ref": "common.json#/$defs/WorkingType"
          },
          "close_position": {
            "type": "boolean"
          }
        },
        "description": "交易所原生保护腿;永远 reduce-only(执行层强制,不作为字段)"
      },
      "Protection": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "take_profits"
        ],
        "properties": {
          "stop": {
            "$ref": "#/$defs/ProtectionLeg"
          },
          "take_profits": {
            "type": "array",
            "maxItems": 4,
            "items": {
              "$ref": "#/$defs/ProtectionLeg"
            }
          }
        }
      },
      "OrderEconomics": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "kind",
          "product",
          "symbol",
          "side",
          "position_side",
          "position_mode",
          "order_type",
          "qty",
          "reduce_only",
          "close_position",
          "protection",
          "max_naked_seconds"
        ],
        "properties": {
          "kind": {
            "const": "order"
          },
          "product": {
            "$ref": "common.json#/$defs/Product"
          },
          "symbol": {
            "$ref": "common.json#/$defs/Symbol"
          },
          "side": {
            "$ref": "common.json#/$defs/Side"
          },
          "position_side": {
            "$ref": "common.json#/$defs/PositionSide"
          },
          "position_mode": {
            "$ref": "common.json#/$defs/PositionMode"
          },
          "order_type": {
            "$ref": "common.json#/$defs/OrderType"
          },
          "qty": {
            "$ref": "common.json#/$defs/UnsignedDecimal",
            "description": "已按 step_size 向下取整"
          },
          "price": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "time_in_force": {
            "$ref": "common.json#/$defs/TimeInForce"
          },
          "reduce_only": {
            "type": "boolean"
          },
          "close_position": {
            "type": "boolean"
          },
          "leverage": {
            "type": "integer",
            "minimum": 1,
            "maximum": 125
          },
          "margin_type": {
            "$ref": "common.json#/$defs/MarginType"
          },
          "trigger_price": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "working_type": {
            "$ref": "common.json#/$defs/WorkingType"
          },
          "protection": {
            "$ref": "#/$defs/Protection"
          },
          "max_naked_seconds": {
            "type": "integer",
            "minimum": 1,
            "maximum": 600,
            "description": "首笔成交后保护腿必须在此秒数内确认在交易所,否则补偿平仓(设计 §5.4,默认 20)"
          }
        },
        "description": "open / close 两类 intent 的计划;close 时 reduce_only=true 且 protection 为空"
      },
      "ProtectEconomics": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "kind",
          "product",
          "symbol",
          "position_side",
          "legs",
          "replace_order_ids"
        ],
        "properties": {
          "kind": {
            "const": "protect"
          },
          "product": {
            "$ref": "common.json#/$defs/Product"
          },
          "symbol": {
            "$ref": "common.json#/$defs/Symbol"
          },
          "position_side": {
            "$ref": "common.json#/$defs/PositionSide"
          },
          "legs": {
            "type": "array",
            "minItems": 1,
            "maxItems": 5,
            "items": {
              "$ref": "#/$defs/ProtectionLeg"
            }
          },
          "replace_order_ids": {
            "type": "array",
            "items": {
              "type": "string",
              "maxLength": 64
            },
            "description": "先撤再挂的本机保护单 exchange_order_id 列表(replace=false 时为空)"
          }
        }
      },
      "CancelEconomics": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "kind",
          "product",
          "symbol"
        ],
        "anyOf": [
          {
            "required": [
              "exchange_order_id"
            ]
          },
          {
            "required": [
              "client_order_id"
            ]
          }
        ],
        "properties": {
          "kind": {
            "const": "cancel"
          },
          "product": {
            "$ref": "common.json#/$defs/Product"
          },
          "symbol": {
            "$ref": "common.json#/$defs/Symbol"
          },
          "exchange_order_id": {
            "type": "string",
            "maxLength": 64
          },
          "client_order_id": {
            "$ref": "common.json#/$defs/ClientOrderId"
          }
        }
      },
      "TransferEconomics": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "kind",
          "asset",
          "amount",
          "from_account",
          "from_wallet",
          "to_account",
          "to_wallet"
        ],
        "properties": {
          "kind": {
            "const": "transfer"
          },
          "asset": {
            "$ref": "common.json#/$defs/Asset"
          },
          "amount": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "from_account": {
            "$ref": "common.json#/$defs/AccountRef"
          },
          "from_wallet": {
            "$ref": "common.json#/$defs/Wallet"
          },
          "to_account": {
            "$ref": "common.json#/$defs/AccountRef"
          },
          "to_wallet": {
            "$ref": "common.json#/$defs/Wallet"
          }
        }
      },
      "SymbolFilters": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "tick_size",
          "step_size",
          "min_qty",
          "min_notional",
          "observed_at"
        ],
        "properties": {
          "tick_size": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "step_size": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "min_qty": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "max_qty": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "min_notional": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "price_precision": {
            "type": "integer",
            "minimum": 0,
            "maximum": 18
          },
          "qty_precision": {
            "type": "integer",
            "minimum": 0,
            "maximum": 18
          },
          "observed_at": {
            "$ref": "common.json#/$defs/TimestampMs"
          }
        }
      },
      "SizingBasis": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "method",
          "raw_qty",
          "rounding"
        ],
        "properties": {
          "method": {
            "type": "string",
            "enum": [
              "risk_pct_by_stop_distance",
              "explicit_qty",
              "explicit_notional",
              "pct_of_position"
            ]
          },
          "equity": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "risk_pct": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "stop_distance": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "reference_price": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "position_qty_before": {
            "$ref": "common.json#/$defs/Decimal"
          },
          "raw_qty": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "rounding": {
            "type": "string",
            "enum": [
              "down"
            ]
          }
        }
      },
      "MarketRef": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "observed_at"
        ],
        "properties": {
          "mark_price": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "last_price": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "observed_at": {
            "$ref": "common.json#/$defs/TimestampMs"
          }
        }
      },
      "PlanBasis": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "notes"
        ],
        "properties": {
          "filters": {
            "$ref": "#/$defs/SymbolFilters"
          },
          "sizing": {
            "$ref": "#/$defs/SizingBasis"
          },
          "account_version": {
            "$ref": "common.json#/$defs/Hash256",
            "description": "物化时的 AccountSnapshot.account_version;派发前变了要重闸"
          },
          "market_ref": {
            "$ref": "#/$defs/MarketRef"
          },
          "position_mode_observed": {
            "$ref": "common.json#/$defs/PositionMode"
          },
          "policy_version": {
            "type": "integer",
            "minimum": 0
          },
          "notes": {
            "type": "array",
            "items": {
              "type": "string",
              "maxLength": 500
            }
          }
        },
        "description": "物化依据,给 UI/审计看;不进 plan_hash"
      }
    }
  },
  "policy": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://trading-swarm.dev/schema/policy.json",
    "title": "ExecPolicy",
    "description": "execd 持有的 policy 子集(设计 §10):模式、authority、上限。gateway 的 gate v2 与 execd 的重闸读同一份;改动需 policy.set + confirm 回填。金丝雀期默认值取 Codex 保守值(§17.2),向导里显式输入。",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schema_version",
      "version",
      "updated_at",
      "mode",
      "authority",
      "emergency_stop",
      "live_capped_enabled",
      "symbol_allowlist",
      "product_allowlist",
      "caps",
      "main_account",
      "canary"
    ],
    "properties": {
      "schema_version": {
        "$ref": "common.json#/$defs/SchemaVersion"
      },
      "version": {
        "type": "integer",
        "minimum": 0
      },
      "updated_at": {
        "$ref": "common.json#/$defs/TimestampMs"
      },
      "mode": {
        "$ref": "common.json#/$defs/PolicyMode"
      },
      "authority": {
        "$ref": "common.json#/$defs/Authority"
      },
      "emergency_stop": {
        "type": "boolean"
      },
      "live_capped_enabled": {
        "type": "boolean",
        "description": "feature gate;v1 保持 false,延后到 §16 Q6(Binance 对 standing authorization 的书面口径)解决"
      },
      "symbol_allowlist": {
        "type": "array",
        "items": {
          "$ref": "common.json#/$defs/Symbol"
        }
      },
      "product_allowlist": {
        "type": "array",
        "items": {
          "$ref": "common.json#/$defs/Product"
        }
      },
      "caps": {
        "$ref": "#/$defs/Caps"
      },
      "main_account": {
        "$ref": "#/$defs/MainAccountPolicy"
      },
      "canary": {
        "$ref": "#/$defs/CanaryPolicy"
      }
    },
    "$defs": {
      "Caps": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "max_leverage",
          "risk_pct_per_trade",
          "max_order_notional",
          "max_position_notional",
          "max_daily_opens",
          "daily_loss_stop_pct",
          "symbol_cooldown_seconds",
          "max_naked_seconds",
          "account_truth_max_age_ms",
          "market_max_age_ms",
          "authorization_ttl_market_seconds",
          "authorization_ttl_limit_seconds",
          "max_price_deviation_bps",
          "ntp_drift_block_ms",
          "ntp_drift_halt_ms"
        ],
        "properties": {
          "max_leverage": {
            "type": "integer",
            "minimum": 1,
            "maximum": 125
          },
          "risk_pct_per_trade": {
            "$ref": "common.json#/$defs/UnsignedDecimal",
            "description": "单笔风险占权益百分比,金丝雀默认 0.25"
          },
          "max_order_notional": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "max_position_notional": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "max_daily_opens": {
            "type": "integer",
            "minimum": 0,
            "description": "金丝雀期默认 2,之后 6"
          },
          "daily_loss_stop_pct": {
            "$ref": "common.json#/$defs/UnsignedDecimal",
            "description": "默认 1"
          },
          "symbol_cooldown_seconds": {
            "type": "integer",
            "minimum": 0,
            "description": "默认 3600"
          },
          "max_naked_seconds": {
            "type": "integer",
            "minimum": 1,
            "maximum": 600,
            "description": "默认 20"
          },
          "account_truth_max_age_ms": {
            "type": "integer",
            "minimum": 1000,
            "description": "默认 15000"
          },
          "market_max_age_ms": {
            "type": "integer",
            "minimum": 500,
            "description": "默认 5000"
          },
          "authorization_ttl_market_seconds": {
            "type": "integer",
            "minimum": 5,
            "maximum": 3600,
            "description": "默认 30"
          },
          "authorization_ttl_limit_seconds": {
            "type": "integer",
            "minimum": 5,
            "maximum": 3600,
            "description": "默认 120"
          },
          "max_price_deviation_bps": {
            "type": "integer",
            "minimum": 0,
            "maximum": 10000,
            "description": "下单价 vs 现价偏离上限"
          },
          "ntp_drift_block_ms": {
            "type": "integer",
            "minimum": 0,
            "description": "默认 2000:超过禁新增风险"
          },
          "ntp_drift_halt_ms": {
            "type": "integer",
            "minimum": 0,
            "description": "默认 10000:超过 HALT"
          }
        }
      },
      "MainAccountPolicy": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "manual_trading_enabled",
          "transfers_enabled",
          "withdraw_enabled"
        ],
        "properties": {
          "manual_trading_enabled": {
            "type": "boolean"
          },
          "transfers_enabled": {
            "type": "boolean",
            "description": "main↔sub 划转(A1 验证可行后才开)"
          },
          "withdraw_enabled": {
            "type": "boolean",
            "const": false,
            "description": "v1 恒 false(§16 Q7 默认不勾提币;提币走 Binance UI 深链)"
          }
        }
      },
      "CanaryPolicy": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "enabled"
        ],
        "properties": {
          "enabled": {
            "type": "boolean"
          },
          "max_loss_quote": {
            "$ref": "common.json#/$defs/UnsignedDecimal",
            "description": "§16 Q2,未答前为空 = 不允许真钱"
          },
          "max_notional_quote": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          },
          "max_leverage": {
            "type": "integer",
            "minimum": 1,
            "maximum": 125
          },
          "funded_balance_quote": {
            "$ref": "common.json#/$defs/UnsignedDecimal"
          }
        }
      }
    }
  },
  "position_effect": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://trading-swarm.dev/schema/position_effect.json",
    "title": "PositionEffect",
    "description": "intent 的经济完成定义(设计 §5.1):开仓=目标数量成交且剩余已撤且保护腿已确认在交易所;平仓=数量核实;保护=腿存在;撤单=订单终态;划转=交易所回执可查。由 reconciler 按读派生并落库,intent 只在 status=satisfied 时才 completed。",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schema_version",
      "effect_id",
      "intent_id",
      "plan_id",
      "kind",
      "account",
      "status",
      "filled_qty",
      "remaining_qty",
      "remaining_canceled",
      "protection_required",
      "protection_confirmed",
      "protection_order_ids",
      "evaluated_at"
    ],
    "properties": {
      "schema_version": {
        "$ref": "common.json#/$defs/SchemaVersion"
      },
      "effect_id": {
        "$ref": "common.json#/$defs/Uuid"
      },
      "intent_id": {
        "$ref": "common.json#/$defs/Uuid"
      },
      "plan_id": {
        "$ref": "common.json#/$defs/Uuid"
      },
      "kind": {
        "$ref": "common.json#/$defs/IntentKind"
      },
      "account": {
        "$ref": "common.json#/$defs/AccountRef"
      },
      "symbol": {
        "$ref": "common.json#/$defs/Symbol"
      },
      "status": {
        "$ref": "common.json#/$defs/EffectStatus"
      },
      "target_qty": {
        "$ref": "common.json#/$defs/UnsignedDecimal"
      },
      "filled_qty": {
        "$ref": "common.json#/$defs/UnsignedDecimal"
      },
      "remaining_qty": {
        "$ref": "common.json#/$defs/UnsignedDecimal"
      },
      "remaining_canceled": {
        "type": "boolean",
        "description": "未成交部分是否已确认撤销(或本就无剩余)"
      },
      "avg_fill_price": {
        "$ref": "common.json#/$defs/UnsignedDecimal"
      },
      "first_fill_at": {
        "$ref": "common.json#/$defs/TimestampMs"
      },
      "protection_required": {
        "type": "boolean"
      },
      "protection_confirmed": {
        "type": "boolean"
      },
      "protection_confirmed_at": {
        "$ref": "common.json#/$defs/TimestampMs"
      },
      "protection_order_ids": {
        "type": "array",
        "items": {
          "type": "string",
          "maxLength": 64
        }
      },
      "naked_seconds": {
        "type": "integer",
        "minimum": 0,
        "description": "首笔成交到保护腿确认(或到现在)的秒数"
      },
      "compensation_close_attempt_id": {
        "$ref": "common.json#/$defs/Uuid",
        "description": "超过 max_naked_seconds 触发的补偿平仓 attempt"
      },
      "position_qty_after": {
        "$ref": "common.json#/$defs/Decimal"
      },
      "exchange_ref": {
        "type": "string",
        "maxLength": 128
      },
      "failure_reason": {
        "type": "string",
        "maxLength": 1000
      },
      "evaluated_at": {
        "$ref": "common.json#/$defs/TimestampMs"
      }
    }
  },
  "rpc": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://trading-swarm.dev/schema/rpc.json",
    "title": "ExecutionServiceRpc",
    "description": "gateway ↔ execd 的 UDS 契约:JSON-RPC 2.0,每帧一行(newline-delimited,UTF-8,单帧 ≤ 4 MiB)。execd 监听 ~/.trading-swarm/run/execd.sock(0600)。请求方法见 Method;execd → gateway 的通知只有 exec.event。错误码映射见 tables/error_codes.json。",
    "oneOf": [
      {
        "$ref": "#/$defs/RpcRequest"
      },
      {
        "$ref": "#/$defs/RpcSuccess"
      },
      {
        "$ref": "#/$defs/RpcFailure"
      },
      {
        "$ref": "#/$defs/RpcNotification"
      }
    ],
    "$defs": {
      "Method": {
        "type": "string",
        "enum": [
          "exec.health",
          "exec.intent.propose",
          "exec.intent.get",
          "exec.intent.list",
          "exec.intent.authorize",
          "exec.intent.reject",
          "exec.account.snapshot",
          "exec.exchange.status",
          "exec.policy.get",
          "exec.policy.set",
          "exec.emergency_stop",
          "exec.events.subscribe",
          "exec.oauth.start",
          "exec.oauth.status",
          "exec.oauth.revoke",
          "exec.credentials.public_key",
          "exec.credentials.set",
          "exec.credentials.status"
        ]
      },
      "RpcId": {
        "oneOf": [
          {
            "type": "string",
            "minLength": 1,
            "maxLength": 64
          },
          {
            "type": "integer",
            "minimum": 0
          }
        ]
      },
      "RpcRequest": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "jsonrpc",
          "id",
          "method",
          "params"
        ],
        "properties": {
          "jsonrpc": {
            "const": "2.0"
          },
          "id": {
            "$ref": "#/$defs/RpcId"
          },
          "method": {
            "$ref": "#/$defs/Method"
          },
          "params": {
            "type": "object"
          }
        }
      },
      "RpcSuccess": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "jsonrpc",
          "id",
          "result"
        ],
        "properties": {
          "jsonrpc": {
            "const": "2.0"
          },
          "id": {
            "$ref": "#/$defs/RpcId"
          },
          "result": {
            "type": "object"
          }
        }
      },
      "RpcErrorData": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "kind",
          "retryable"
        ],
        "properties": {
          "kind": {
            "$ref": "common.json#/$defs/ErrorKind"
          },
          "retryable": {
            "type": "boolean"
          },
          "details": {
            "type": "object"
          }
        }
      },
      "RpcError": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "code",
          "message",
          "data"
        ],
        "properties": {
          "code": {
            "type": "integer"
          },
          "message": {
            "type": "string",
            "maxLength": 2000
          },
          "data": {
            "$ref": "#/$defs/RpcErrorData"
          }
        }
      },
      "RpcFailure": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "jsonrpc",
          "id",
          "error"
        ],
        "properties": {
          "jsonrpc": {
            "const": "2.0"
          },
          "id": {
            "oneOf": [
              {
                "$ref": "#/$defs/RpcId"
              },
              {
                "type": "null"
              }
            ]
          },
          "error": {
            "$ref": "#/$defs/RpcError"
          }
        }
      },
      "RpcNotification": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "jsonrpc",
          "method",
          "params"
        ],
        "properties": {
          "jsonrpc": {
            "const": "2.0"
          },
          "method": {
            "const": "exec.event"
          },
          "params": {
            "$ref": "events.json"
          }
        }
      },
      "ChannelHealth": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "state"
        ],
        "properties": {
          "state": {
            "type": "string",
            "enum": [
              "ok",
              "degraded",
              "down",
              "unconfigured"
            ]
          },
          "detail": {
            "type": "string",
            "maxLength": 500
          },
          "last_ok_at": {
            "$ref": "common.json#/$defs/TimestampMs"
          }
        }
      },
      "HealthParams": {
        "type": "object",
        "additionalProperties": false,
        "properties": {}
      },
      "HealthResult": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "ok",
          "version",
          "writer_instance_id",
          "lease_epoch",
          "started_at",
          "now",
          "db_ok",
          "mode",
          "halted",
          "open_intents",
          "unknown_attempts",
          "channels"
        ],
        "properties": {
          "ok": {
            "type": "boolean"
          },
          "version": {
            "type": "string",
            "maxLength": 64
          },
          "writer_instance_id": {
            "type": "string",
            "maxLength": 128
          },
          "lease_epoch": {
            "type": "integer",
            "minimum": 0
          },
          "started_at": {
            "$ref": "common.json#/$defs/TimestampMs"
          },
          "now": {
            "$ref": "common.json#/$defs/TimestampMs"
          },
          "db_ok": {
            "type": "boolean"
          },
          "mode": {
            "$ref": "common.json#/$defs/PolicyMode"
          },
          "halted": {
            "type": "boolean"
          },
          "open_intents": {
            "type": "integer",
            "minimum": 0
          },
          "unknown_attempts": {
            "type": "integer",
            "minimum": 0
          },
          "channels": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "main",
              "sub"
            ],
            "properties": {
              "main": {
                "$ref": "#/$defs/ChannelHealth"
              },
              "sub": {
                "$ref": "#/$defs/ChannelHealth"
              }
            }
          }
        }
      },
      "IntentProposeParams": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "account",
          "principal",
          "surface",
          "params"
        ],
        "properties": {
          "account": {
            "$ref": "common.json#/$defs/AccountRef"
          },
          "principal": {
            "$ref": "common.json#/$defs/Principal"
          },
          "surface": {
            "$ref": "common.json#/$defs/Surface"
          },
          "session_id": {
            "type": "string",
            "maxLength": 128
          },
          "run_id": {
            "type": "string",
            "maxLength": 128
          },
          "origin": {
            "type": "string",
            "maxLength": 256
          },
          "idempotency_key": {
            "type": "string",
            "maxLength": 128
          },
          "params": {
            "$ref": "intent.json#/$defs/IntentParams"
          },
          "ttl_seconds": {
            "type": "integer",
            "minimum": 1,
            "maximum": 86400
          }
        }
      },
      "IntentProposeResult": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "intent",
          "gate_rejections"
        ],
        "properties": {
          "intent": {
            "$ref": "intent.json"
          },
          "plan": {
            "$ref": "plan.json"
          },
          "gate_rejections": {
            "type": "array",
            "items": {
              "$ref": "common.json#/$defs/GateRejection"
            }
          }
        }
      },
      "IntentGetParams": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "intent_id"
        ],
        "properties": {
          "intent_id": {
            "$ref": "common.json#/$defs/Uuid"
          }
        }
      },
      "IntentBundle": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "intent",
          "attempts",
          "orders",
          "fills"
        ],
        "properties": {
          "intent": {
            "$ref": "intent.json"
          },
          "plan": {
            "$ref": "plan.json"
          },
          "authorization": {
            "$ref": "authorization.json"
          },
          "attempts": {
            "type": "array",
            "items": {
              "$ref": "attempt.json"
            }
          },
          "orders": {
            "type": "array",
            "items": {
              "$ref": "exchange_order.json"
            }
          },
          "fills": {
            "type": "array",
            "items": {
              "$ref": "fill.json"
            }
          },
          "effect": {
            "$ref": "position_effect.json"
          }
        }
      },
      "IntentListParams": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "status": {
            "type": "array",
            "items": {
              "$ref": "common.json#/$defs/IntentStatus"
            }
          },
          "account": {
            "$ref": "common.json#/$defs/AccountRef"
          },
          "kind": {
            "$ref": "common.json#/$defs/IntentKind"
          },
          "since": {
            "$ref": "common.json#/$defs/TimestampMs"
          },
          "limit": {
            "type": "integer",
            "minimum": 1,
            "maximum": 500
          }
        }
      },
      "IntentListResult": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "intents"
        ],
        "properties": {
          "intents": {
            "type": "array",
            "items": {
              "$ref": "intent.json"
            }
          }
        }
      },
      "IntentAuthorizeParams": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "intent_id",
          "plan_hash",
          "principal",
          "surface",
          "confirm_echo"
        ],
        "properties": {
          "intent_id": {
            "$ref": "common.json#/$defs/Uuid"
          },
          "plan_hash": {
            "$ref": "common.json#/$defs/Hash256"
          },
          "principal": {
            "$ref": "common.json#/$defs/Principal"
          },
          "surface": {
            "$ref": "common.json#/$defs/Surface"
          },
          "actor_ref": {
            "type": "string",
            "maxLength": 256
          },
          "confirm_echo": {
            "type": "object",
            "additionalProperties": {
              "type": "string",
              "maxLength": 200
            }
          }
        },
        "description": "只接受 principal=user;plan_hash 或 confirm_echo 与当前 plan 不符 → conflict"
      },
      "IntentAuthorizeResult": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "intent",
          "authorization"
        ],
        "properties": {
          "intent": {
            "$ref": "intent.json"
          },
          "authorization": {
            "$ref": "authorization.json"
          }
        }
      },
      "IntentRejectParams": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "intent_id",
          "reason",
          "principal",
          "surface"
        ],
        "properties": {
          "intent_id": {
            "$ref": "common.json#/$defs/Uuid"
          },
          "reason": {
            "type": "string",
            "maxLength": 1000
          },
          "principal": {
            "$ref": "common.json#/$defs/Principal"
          },
          "surface": {
            "$ref": "common.json#/$defs/Surface"
          }
        }
      },
      "IntentRejectResult": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "intent"
        ],
        "properties": {
          "intent": {
            "$ref": "intent.json"
          }
        }
      },
      "AccountSnapshotParams": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "account"
        ],
        "properties": {
          "account": {
            "$ref": "common.json#/$defs/AccountRef"
          },
          "max_age_ms": {
            "type": "integer",
            "minimum": 0
          },
          "force_refresh": {
            "type": "boolean"
          }
        }
      },
      "AccountSnapshotResult": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "snapshot"
        ],
        "properties": {
          "snapshot": {
            "$ref": "account_snapshot.json"
          }
        }
      },
      "OauthState": {
        "type": "string",
        "enum": [
          "missing",
          "fresh",
          "expiring",
          "expired",
          "revoked"
        ]
      },
      "OauthStatus": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "state",
          "has_refresh"
        ],
        "properties": {
          "state": {
            "$ref": "#/$defs/OauthState"
          },
          "expires_at": {
            "$ref": "common.json#/$defs/TimestampMs"
          },
          "has_refresh": {
            "type": "boolean"
          },
          "scopes": {
            "type": "array",
            "items": {
              "type": "string",
              "maxLength": 64
            }
          },
          "client_id": {
            "type": "string",
            "maxLength": 512
          },
          "obtained_at": {
            "$ref": "common.json#/$defs/TimestampMs"
          }
        }
      },
      "MainKeyPermissions": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "reading": {
            "type": "boolean"
          },
          "spot_margin_trading": {
            "type": "boolean"
          },
          "futures": {
            "type": "boolean"
          },
          "universal_transfer": {
            "type": "boolean"
          },
          "withdrawals": {
            "type": "boolean"
          },
          "ip_restricted": {
            "type": "boolean"
          }
        }
      },
      "MainChannelStatus": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "configured",
          "user_stream",
          "rest_gate"
        ],
        "properties": {
          "configured": {
            "type": "boolean"
          },
          "key_fingerprint": {
            "type": "string",
            "maxLength": 32,
            "description": "sha256(api_key) 前 16 hex,只用于识别不是密钥"
          },
          "permissions": {
            "$ref": "#/$defs/MainKeyPermissions"
          },
          "user_stream": {
            "type": "string",
            "enum": [
              "connected",
              "stale",
              "disconnected",
              "unconfigured"
            ]
          },
          "time_offset_ms": {
            "type": "integer"
          },
          "rest_gate": {
            "type": "string",
            "enum": [
              "ready",
              "wait",
              "banned",
              "unconfigured"
            ]
          },
          "last_verified_at": {
            "$ref": "common.json#/$defs/TimestampMs"
          }
        }
      },
      "SubChannelStatus": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "configured",
          "oauth",
          "mcp_session",
          "drift"
        ],
        "properties": {
          "configured": {
            "type": "boolean"
          },
          "oauth": {
            "$ref": "#/$defs/OauthStatus"
          },
          "mcp_session": {
            "type": "string",
            "enum": [
              "active",
              "none",
              "lost"
            ]
          },
          "tools_hash": {
            "$ref": "common.json#/$defs/Hash256"
          },
          "tools_pinned_hash": {
            "$ref": "common.json#/$defs/Hash256"
          },
          "tools_count": {
            "type": "integer",
            "minimum": 0
          },
          "drift": {
            "type": "boolean",
            "description": "tools_hash != tools_pinned_hash → 写路径 HALT"
          },
          "subaccount_ref": {
            "type": "string",
            "maxLength": 128,
            "description": "Agentic 子账户稳定标识(A1 实测 MCP 是否暴露)"
          }
        }
      },
      "ExchangeStatusParams": {
        "type": "object",
        "additionalProperties": false,
        "properties": {}
      },
      "ExchangeStatusResult": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "main",
          "sub",
          "writer"
        ],
        "properties": {
          "main": {
            "$ref": "#/$defs/MainChannelStatus"
          },
          "sub": {
            "$ref": "#/$defs/SubChannelStatus"
          },
          "writer": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "instance_id",
              "lease_epoch",
              "since"
            ],
            "properties": {
              "instance_id": {
                "type": "string",
                "maxLength": 128
              },
              "lease_epoch": {
                "type": "integer",
                "minimum": 0
              },
              "since": {
                "$ref": "common.json#/$defs/TimestampMs"
              }
            }
          }
        }
      },
      "PolicyGetParams": {
        "type": "object",
        "additionalProperties": false,
        "properties": {}
      },
      "PolicyGetResult": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "policy"
        ],
        "properties": {
          "policy": {
            "$ref": "policy.json"
          }
        }
      },
      "PolicySetParams": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "policy",
          "confirm",
          "principal",
          "surface"
        ],
        "properties": {
          "policy": {
            "$ref": "policy.json"
          },
          "confirm": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "mode",
              "authority"
            ],
            "properties": {
              "mode": {
                "type": "string",
                "maxLength": 32
              },
              "authority": {
                "type": "string",
                "maxLength": 32
              }
            },
            "description": "逐字回填新 policy 的 mode/authority(设计 §10.4)"
          },
          "principal": {
            "$ref": "common.json#/$defs/Principal"
          },
          "surface": {
            "$ref": "common.json#/$defs/Surface"
          }
        }
      },
      "PolicySetResult": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "policy"
        ],
        "properties": {
          "policy": {
            "$ref": "policy.json"
          }
        }
      },
      "EmergencyStopParams": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "mode",
          "reason",
          "principal",
          "surface"
        ],
        "properties": {
          "mode": {
            "type": "string",
            "enum": [
              "stop_opening",
              "flatten_only",
              "halt_all"
            ]
          },
          "reason": {
            "type": "string",
            "maxLength": 1000
          },
          "principal": {
            "$ref": "common.json#/$defs/Principal"
          },
          "surface": {
            "$ref": "common.json#/$defs/Surface"
          }
        },
        "description": "只能收紧;放松要走 policy.set + confirm"
      },
      "EmergencyStopResult": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "policy"
        ],
        "properties": {
          "policy": {
            "$ref": "policy.json"
          }
        }
      },
      "EventsSubscribeParams": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "since_seq": {
            "type": "integer",
            "minimum": 0
          }
        }
      },
      "EventsSubscribeResult": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "ok",
          "current_seq"
        ],
        "properties": {
          "ok": {
            "type": "boolean"
          },
          "current_seq": {
            "type": "integer",
            "minimum": 0
          }
        }
      },
      "OauthStartParams": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "scopes": {
            "type": "array",
            "items": {
              "type": "string",
              "maxLength": 64
            }
          },
          "open_browser": {
            "type": "boolean"
          }
        }
      },
      "OauthStartResult": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "authorize_url",
          "state",
          "expires_at"
        ],
        "properties": {
          "authorize_url": {
            "type": "string",
            "maxLength": 4096
          },
          "state": {
            "type": "string",
            "maxLength": 128
          },
          "expires_at": {
            "$ref": "common.json#/$defs/TimestampMs"
          }
        },
        "description": "回调由 execd 自己在回环端口接收;code/verifier 不经过 gateway"
      },
      "OauthStatusParams": {
        "type": "object",
        "additionalProperties": false,
        "properties": {}
      },
      "OauthStatusResult": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "oauth"
        ],
        "properties": {
          "oauth": {
            "$ref": "#/$defs/OauthStatus"
          }
        }
      },
      "OauthRevokeParams": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "principal",
          "surface"
        ],
        "properties": {
          "principal": {
            "$ref": "common.json#/$defs/Principal"
          },
          "surface": {
            "$ref": "common.json#/$defs/Surface"
          }
        }
      },
      "OauthRevokeResult": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "ok"
        ],
        "properties": {
          "ok": {
            "type": "boolean"
          }
        }
      },
      "SealedSecret": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "alg",
          "ephemeral_public_key",
          "iv",
          "ciphertext"
        ],
        "properties": {
          "alg": {
            "const": "ecdh-p256-hkdf-sha256-aes256gcm"
          },
          "ephemeral_public_key": {
            "type": "string",
            "maxLength": 200,
            "description": "base64,65 字节未压缩点"
          },
          "iv": {
            "type": "string",
            "maxLength": 32,
            "description": "base64,12 字节"
          },
          "ciphertext": {
            "type": "string",
            "maxLength": 8192,
            "description": "base64;明文是 UTF-8 JSON {api_key, api_secret}"
          }
        },
        "description": "浏览器用 execd 的 P-256 公钥做 ECDH → HKDF-SHA256(salt 空, info 'trading-swarm/credentials/v1') → AES-256-GCM;gateway 只转发密文,TS 进程永远拿不到明文(AGENTS.md 规矩 1)"
      },
      "CredentialsPublicKeyParams": {
        "type": "object",
        "additionalProperties": false,
        "properties": {}
      },
      "CredentialsPublicKeyResult": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "alg",
          "public_key",
          "expires_at"
        ],
        "properties": {
          "alg": {
            "const": "ecdh-p256-hkdf-sha256-aes256gcm"
          },
          "public_key": {
            "type": "string",
            "maxLength": 200
          },
          "expires_at": {
            "$ref": "common.json#/$defs/TimestampMs"
          }
        }
      },
      "CredentialsSetParams": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "kind",
          "sealed",
          "principal",
          "surface"
        ],
        "properties": {
          "kind": {
            "type": "string",
            "enum": [
              "main_api_key"
            ]
          },
          "sealed": {
            "$ref": "#/$defs/SealedSecret"
          },
          "principal": {
            "$ref": "common.json#/$defs/Principal"
          },
          "surface": {
            "$ref": "common.json#/$defs/Surface"
          }
        }
      },
      "CredentialsSetResult": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "ok"
        ],
        "properties": {
          "ok": {
            "type": "boolean"
          },
          "key_fingerprint": {
            "type": "string",
            "maxLength": 32
          },
          "permissions": {
            "$ref": "#/$defs/MainKeyPermissions"
          }
        }
      },
      "CredentialsStatusParams": {
        "type": "object",
        "additionalProperties": false,
        "properties": {}
      },
      "CredentialsStatusResult": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "main_api_key",
          "oauth"
        ],
        "properties": {
          "main_api_key": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "present"
            ],
            "properties": {
              "present": {
                "type": "boolean"
              },
              "key_fingerprint": {
                "type": "string",
                "maxLength": 32
              },
              "permissions": {
                "$ref": "#/$defs/MainKeyPermissions"
              },
              "last_verified_at": {
                "$ref": "common.json#/$defs/TimestampMs"
              }
            }
          },
          "oauth": {
            "$ref": "#/$defs/OauthStatus"
          }
        }
      }
    }
  }
} as const;
