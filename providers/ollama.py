# @project  Red Studio  V1.2
# @author   Red
# @since    2026-05-14

import requests
import json
from typing import Generator

# 260514 Red Ollama 使用自己的 REST API，不完全兼容 OpenAI 格式
# 文档参考: https://github.com/ollama/ollama/blob/main/docs/api.md


def list_models(base_url: str) -> list[str]:
    """获取 Ollama 本地已安装的模型列表"""
    try:
        # 260514 Red timeout=5 用于列表查询，响应应该很快；超时说明服务未启动
        resp = requests.get(f"{base_url}/api/tags", timeout=5)
        # 260514 Red raise_for_status() 将 4xx/5xx HTTP 状态码转为异常，统一错误处理
        resp.raise_for_status()
        data = resp.json()
        # 260514 Red 返回模型名称列表，格式如 "llama3.2:latest"
        return [m["name"] for m in data.get("models", [])]
    except requests.exceptions.ConnectionError:
        raise ConnectionError("无法连接到 Ollama，请确认服务已启动（ollama serve）")
    except Exception as e:
        raise RuntimeError(f"获取模型列表失败: {e}")


def chat_stream(base_url: str, model: str, messages: list, temperature: float = 0.7,
                max_tokens: int = 4096, top_p: float = 1.0) -> Generator[str, None, None]:
    """
    流式对话，使用 Ollama /api/chat 接口
    每次 yield 一段增量文本（delta），由 server.py 包装成 SSE 格式
    """
    payload = {
        "model": model,
        "messages": messages,
        "stream": True,
        "options": {
            "temperature": temperature,
            # 260514 Red num_predict 是 Ollama 对 max_tokens 的等效参数
            "num_predict": max_tokens,
            "top_p": top_p
        }
    }
    try:
        with requests.post(
            f"{base_url}/api/chat",
            json=payload,
            # 260514 Red stream=True 让 requests 不等待整个响应，而是按块接收，配合 iter_lines 使用
            stream=True,
            # 260514 Red timeout=120 给生成留出足够时间，长文本或慢模型可能需要更长
            timeout=120
        ) as resp:
            resp.raise_for_status()
            # 260514 Red iter_lines() 按换行符切割响应体，每行是一个完整的 JSON 对象
            for line in resp.iter_lines():
                if not line:
                    continue
                try:
                    chunk = json.loads(line)
                    # 260514 Red Ollama 流式响应结构: {"message": {"content": "..."}, "done": false}
                    # 260514 Red done=true 时表示本次生成完成，退出循环
                    delta = chunk.get("message", {}).get("content", "")
                    if delta:
                        yield delta
                    if chunk.get("done"):
                        # 260514 Red done=true 的最终块包含 token 统计字段
                        # 260514 Red prompt_eval_count=输入 tokens，eval_count=输出 tokens
                        # 260514 Red 始终 yield usage，即使为 0（前端依赖此事件渲染 token 标注）
                        yield ("usage", {
                            "prompt_tokens":     chunk.get("prompt_eval_count", 0),
                            "completion_tokens": chunk.get("eval_count", 0)
                        })
                        break
                except json.JSONDecodeError:
                    # 260514 Red 极少情况下收到非 JSON 行（如心跳），直接跳过
                    continue
    except requests.exceptions.ConnectionError:
        raise ConnectionError("无法连接到 Ollama，请确认服务已启动")
    except Exception as e:
        raise RuntimeError(f"对话请求失败: {e}")
