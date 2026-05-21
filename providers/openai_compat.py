# @project  Red Studio  V1.2
# @author   Red
# @since    2026-05-14

import requests
import json
from typing import Generator

# 260514 Red OpenAI 兼容格式，适用于:
#   - OpenAI (https://api.openai.com/v1)
#   - DeepSeek (https://api.deepseek.com/v1)
#   - 硅基流动 (https://api.siliconflow.cn/v1)
#   - 本地 vLLM / LM Studio 等


def list_models(base_url: str, api_key: str) -> list[str]:
    """获取可用模型列表，通过 /models 接口"""
    # 260514 Red OpenAI 使用 Bearer Token 鉴权，格式固定为 "Bearer <api_key>"
    headers = {"Authorization": f"Bearer {api_key}"}
    try:
        resp = requests.get(f"{base_url}/models", headers=headers, timeout=10)
        resp.raise_for_status()
        data = resp.json()
        # 260514 Red 响应结构: {"data": [{"id": "gpt-4o", ...}, ...]}
        # 260514 Red 按 id 字母排序，方便用户在下拉框中查找
        models = [m["id"] for m in data.get("data", [])]
        return sorted(models)
    except requests.exceptions.ConnectionError:
        raise ConnectionError(f"无法连接到 {base_url}")
    except requests.exceptions.HTTPError as e:
        # 260514 Red 401 专门提示 Key 问题，其他 HTTP 错误统一抛出
        if e.response.status_code == 401:
            raise PermissionError("API Key 无效或未设置")
        raise RuntimeError(f"获取模型列表失败: {e}")
    except Exception as e:
        raise RuntimeError(f"获取模型列表失败: {e}")


def chat_stream(
    base_url: str,
    api_key: str,
    model: str,
    messages: list,
    temperature: float = 0.7,
    max_tokens: int = 4096,
    top_p: float = 1.0,
    frequency_penalty: float = 0.0,
    presence_penalty: float = 0.0,
    thinking: bool = False
) -> Generator:
    """
    流式对话，使用标准 OpenAI /chat/completions 接口（SSE 格式）
    每次 yield 一段增量文本
    """
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }
    payload = {
        "model": model,
        "messages": messages,
        "stream": True,
        "temperature": temperature,
        "max_tokens": max_tokens,
        # 260514 Red top_p / frequency_penalty / presence_penalty 为标准 OpenAI 参数
        # 260514 Red 值为默认值时也显式传递，让模型行为与设置面板保持一致
        "top_p": top_p,
        "frequency_penalty": frequency_penalty,
        "presence_penalty": presence_penalty,
        # 260514 Red 请求 API 在流结束时附带 usage 统计，用于显示 token 消耗
        "stream_options": {"include_usage": True}
    }
    # 260514 Red 思考模式开启时，对支持该参数的模型（如 DeepSeek-V3 新版）传入开关
    # 260514 Red DeepSeek-R1 系列不需要此参数（思考始终开启）
    if thinking:
        payload["enable_thinking"] = True
    try:
        with requests.post(
            f"{base_url}/chat/completions",
            headers=headers,
            json=payload,
            stream=True,
            timeout=120
        ) as resp:
            resp.raise_for_status()
            for line in resp.iter_lines():
                if not line:
                    continue
                # 260514 Red OpenAI SSE 每行格式: "data: {...}" 或 "data: [DONE]"
                # 260514 Red iter_lines 可能返回 bytes 或 str，统一 decode
                text = line.decode("utf-8") if isinstance(line, bytes) else line
                if not text.startswith("data:"):
                    # 260514 Red 忽略 "event:"、"id:" 等其他 SSE 字段行
                    continue
                # 260514 Red "data:" 是 5 个字符，切片后 strip 去掉可能的空格
                payload_str = text[5:].strip()
                if payload_str == "[DONE]":
                    break
                try:
                    chunk = json.loads(payload_str)
                    # 260514 Red 部分 API 把 usage 附在最后一个内容块（choices 非空），
                    # 260514 Red 部分 API 单独发一个 choices=[] 的 usage 块
                    # 260514 Red 独立检测，不依赖 choices 是否为空
                    usage_data = chunk.get("usage")
                    if usage_data and usage_data.get("prompt_tokens") is not None:
                        yield ("usage", {
                            "prompt_tokens":     usage_data.get("prompt_tokens", 0),
                            "completion_tokens": usage_data.get("completion_tokens", 0)
                        })
                    choices = chunk.get("choices", [])
                    if not choices:
                        continue
                    delta_obj = choices[0].get("delta", {})
                    # 260514 Red reasoning_content 是 DeepSeek-R1 等模型输出思考过程的字段
                    reason = delta_obj.get("reasoning_content", "") or ""
                    content = delta_obj.get("content", "") or ""
                    if reason:
                        yield ("reason", reason)
                    if content:
                        yield ("content", content)
                except (json.JSONDecodeError, KeyError, IndexError):
                    continue
    except requests.exceptions.ConnectionError:
        raise ConnectionError(f"无法连接到 {base_url}")
    except requests.exceptions.HTTPError as e:
        if e.response.status_code == 401:
            raise PermissionError("API Key 无效或未设置")
        raise RuntimeError(f"对话请求失败: {e}")
    except Exception as e:
        raise RuntimeError(f"对话请求失败: {e}")
