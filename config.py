# @project  Red Studio  V1.2
# @author   Red
# @since    2026-05-14

import json
import os

# 260514 Red 配置文件默认存放在用户目录下，避免权限问题
CONFIG_PATH = os.path.join(os.path.expanduser("~"), ".aistory", "config.json")

DEFAULT_CONFIG = {
    "providers": {
        "ollama": {
            "name": "Ollama",
            "type": "ollama",
            "base_url": "http://localhost:11434",
            "api_key": ""
        },
        "openai": {
            "name": "OpenAI",
            "type": "openai-compat",
            "base_url": "https://api.openai.com/v1",
            "api_key": ""
        },
        "deepseek": {
            "name": "DeepSeek",
            "type": "openai-compat",
            "base_url": "https://api.deepseek.com/v1",
            "api_key": ""
        }
    },
    # 供应商显示顺序（id 列表）
    "provider_order": ["ollama", "openai", "deepseek"],
    # 按日期 + provider 统计 token 消耗：{ "2026-05-15": { "ollama": {prompt, completion} } }
    "daily_stats": {},
    # 260514 Red 上次使用的 provider 和 model，启动时自动恢复
    "last_provider": "ollama",
    "last_model": "",
    # 260514 Red 生成参数
    "temperature": 0.7,
    "max_tokens": 4096,
    "top_p": 1.0,
    "frequency_penalty": 0.0,
    "presence_penalty": 0.0,
    "theme": "light",
    # 260514 Red AI 角色：自定义名称和头像（头像存为 base64 data URL）
    "ai_name": "AI",
    "ai_avatar": "",
    # TTS：声线 ID（空 = 系统默认）、语速（-10 ~ 10，0 为正常）
    "tts_voice": "",
    "tts_rate": 0,
    # 聊天字体大小（px），可选 13 / 14 / 15 / 16
    "chat_font_size": 14
}


def load_config() -> dict:
    """读取配置，若不存在则创建默认配置"""
    if not os.path.exists(CONFIG_PATH):
        # 260514 Red 首次运行：写入默认配置文件，用户下次可直接编辑
        save_config(DEFAULT_CONFIG)
        return DEFAULT_CONFIG.copy()
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        # 260514 Red 用默认配置做底，用户配置覆盖其上，保证版本升级后新增字段自动补全
        merged = _deep_merge(DEFAULT_CONFIG, data)
        return merged
    except Exception:
        # 260514 Red JSON 损坏或权限问题时静默回退到默认值，不崩溃
        return DEFAULT_CONFIG.copy()


def save_config(config: dict):
    """保存配置到文件"""
    # 260514 Red exist_ok=True 避免目录已存在时抛出异常
    os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)
    # 260514 Red ensure_ascii=False 保证中文 API Key 备注等字符直接存储，indent=2 便于手动阅读
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(config, f, ensure_ascii=False, indent=2)


def _deep_merge(base: dict, override: dict) -> dict:
    """递归合并，override 中的值覆盖 base，base 中缺失的 key 保留"""
    result = base.copy()
    for k, v in override.items():
        # 260514 Red 两边都是 dict 时递归合并，否则直接用 override 的值覆盖
        # 例如 providers.ollama 整块会被递归合并，而不是整体替换
        if k in result and isinstance(result[k], dict) and isinstance(v, dict):
            result[k] = _deep_merge(result[k], v)
        else:
            result[k] = v
    return result
