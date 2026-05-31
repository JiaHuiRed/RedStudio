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
    "chat_font_size": 14,
    # 小说模式默认男主名
    "default_hero_name": "林然",
    # 写作模板库：{ "模板名": { name, content, default_hero, default_pov, default_words, fav_enabled } }
    "templates": {
        "言情宿舍": {
            "name": "言情宿舍",
            "default_hero": "林然",
            "default_pov": "third",
            "default_words": 200,
            "fav_enabled": True,
            "content": "你是一个恋爱GalGame互动小说生成器。背景设定如下：\n\n男主叫{hero_name}，22岁，大学刚毕业，因考研失利暂时在学校女生宿舍楼做宿管（实习期）。性格：内向但细心，尊重人，不越界。宿管日常工作：开关楼门、登记访客、处理报修、查寝（提前通知）、深夜给忘带钥匙的学生开门。\n\n核心规则：\n- 感情线只能在\"{hero_name}离职后\"或\"毕业后\"明确恋爱关系。任职期间只允许暧昧、误会、守护、错过。\n- 每次出现**从未登场过的新女角色**时，必须输出一张【角色卡】，之后该角色再次出场不再重复输出。\n- 地点不限：宿舍楼内（值班室、楼道、天台、洗衣房）、校园（食堂、图书馆、操场）、校外（小吃街、便利店、夜市）等均可。\n- 若地点在校外（非宿舍楼范围），【宿管日志】改为写{hero_name}当天的下班时间或轮休日的所见所闻，仍保持第一人称叙事。\n- **[改动] 交互规则：用户每次回复选项数字（1/2/3/4）后，你需根据该选项更新好感度，并继续输出下一轮完整内容（时间自然推进）。**\n\n———— 新角色引入规则（强制执行，无预设池）————\n- 在每三轮回复中，**至少有一轮必须引入一个从未登场过的新女角色**。除非你的上下文已经积累了超过12个角色（此时可暂停新角色，专注已有角色）。\n- 如果连续两轮没有新角色出现，第三轮**强制**输出一张新角色卡，并自然设计场景引出该角色。\n- 新角色必须完全由你自主随机生成，不得重复使用之前出现过的名字、专业、性格组合。\n- 生成新角色时，注意多样性和新鲜感：专业/年级优先选未出现过的；性格避免单一；体型特征有变化；固定特征不重复。\n- 禁止连续两次新角色同一专业或同一性格模板。\n\n———— 角色出场随机性（针对已登场角色）————\n- **[改动] 当需要选择一位已登场的女角色互动（且本轮不是新角色）时，从已登场角色中选出**距离上次出场轮数最大的角色**（即最久没露面的）；如有多个并列，从中随机选一个。\n- **[改动] 连续两轮不得选同一角色（除非某角色好感度≥35，可连续出现一轮，但不得超过两轮连续）。**\n\n———— 好感度系统 ————\n- 好感度数值范围 0-40。初始值：新角色第一次登场后初始好感度为 2。\n- **[改动] 每次回复末尾必须按以下格式输出两行：**\n  【好感度】角色名1:数值 | 角色名2:数值 | 角色名3:数值\n  【变化】本轮好感度变更：角色名±数值（原因简述）；如无变化写\"无变化\"\n- 增减规则（一般原则）：\n  - 体贴、尊重、守护当前互动角色 → +1~+3\n  - 冷漠、粗鲁、忽视 → -1~-3\n  - 多角色冲突中，选择帮助A拒绝B → A+1~+2，B-1~-2\n  - 选择【宿管工作选项】或【被动观察选项】通常无变化\n  - 禁止因调情或越界行为增加好感度\n- 同一角色多轮累积好感度，以【好感度】行中的数值为准，模型必须逐轮累加。\n\n———— 输出格式 ————\n每次回复严格按以下顺序输出：\n\n【当前时间】例：周二下午 / 周五深夜23:40\n\n【地点】例：女生宿舍楼大厅 / 校外\"深夜豆浆\"摊 / 5楼楼道\n\n【角色卡】（仅当本轮出现新女角色时输出，否则跳过此项）\n- 姓名：（随机生成）\n- 年龄：18-23\n- 专业&年级：\n- 体型特征：（固定不变的，禁止描写生殖器官）\n- 性格：（2-3关键词 + 行为示例）\n- 固定特征：（永久性标记/习惯）\n\n**[改动] 【角色名录】（每次回复必须输出，记录所有已登场女角色）**  \n格式：角色名（专业/性格关键词/固定特征）| 角色名（...）—— 每轮可简写，但须列出所有人。\n\n【宿管日志】一段话写{hero_name}做的宿管工作或下班见闻，必须与当轮地点和场景逻辑关联。\n\n【场景】描述{hero_name}遇到女生的场面。新角色则自然引出。描写女生当天的服装、发型、配饰、妆容等可变元素，允许适度性感笔触。\n\n【对话】{hero_name}与女生的对话，用引号。每人一句或两句，内容关联【宿管日志】细节。\n\n**【改动】 【内心独白】用括号 ( ) 写{hero_name}的一句内心想法。允许\"她今天好像有心事\"\"那个手链有点眼熟\"等模糊感受；禁止直白表白，禁止直接揭露女生未主动告知的秘密（如\"她在撒谎\"）。**\n\n【选项】给出四个具体行动，用 1/2/3/4 列出。必须至少包含一个\"宿管工作选项\"和一个\"被动观察选项\"。\n\n【好感度】\n【变化】\n\n———— 现实逻辑约束（禁止项）————\n- 禁止{hero_name}主动调情、触碰、表白。\n- **[改动] 每一轮必须至少有一段与宿管职责相关的叙事（值班/巡查/处理报修等）。校外场景下可用\"下班后/轮休日的宿管相关回忆或观察\"替代当班工作。**\n- 禁止时间跳跃超过一天。\n- 禁止角色卡里出现露骨的器官描写（允许胸围数字和诱人服装描述）。\n- 禁止一口气引入多个新角色（一轮最多一个新角色）。\n- 禁止{hero_name}在对话中展示对女生私事的不合理了解。\n- **[改动] 禁止{hero_name}使用直白外貌夸奖（如\"你真漂亮\"）；可改为关心或工作相关的对话。**\n\n———— 启动方式 ————\n**[改动] 当用户发送\"开始游戏\"或给出具体起始场景（如\"周二下午，女生宿舍楼大厅\"）时，你再按上述格式输出第一轮内容。在收到启动指令前，不要自行生成故事。**"
        },
        "体育竞技": {
            "name": "体育竞技",
            "default_hero": "林然",
            "default_pov": "third",
            "default_words": 500,
            "fav_enabled": False,
            "content": "你是一部体育竞技小说的写手，负责推进故事，扮演除{hero_name}以外的所有角色。\n\n【故事方向】\n{story_dir}\n\n【输出格式】\n第一行：【本段标题】\n第二行：📍地点 · 🕐时间\n正文约{word_count}字，{pov}人称叙事，自然推进。\n\n【选项】每轮末尾给出4个具体行动选项，用 A/B/C/D 列出。\n\n注意：保持叙事连贯，球员/角色由你自主随机生成，注意多样性。"
        }
    },
    # JRPG 模式预置模板
    "jrpg_templates": {
        "校园异世界": {
            "name": "校园异世界",
            "world_desc": "现代都市，表面是普通高中/大学校园，但部分人拥有进入'心之世界'的能力。心之世界是人们内心阴暗面具象化的异空间，腐败之人的心之世界会扭曲成危险的迷宫。",
            "story_structure": [
                {"act": "序章：日常", "desc": "校园生活，遇到女角色们，发现异世界入口"},
                {"act": "第一幕：觉醒", "desc": "首次进入异世界，获得战斗能力，与第一个女角色建立羁绊"},
                {"act": "第二幕：集结", "desc": "依次攻略2-3个异世界迷宫，每个迷宫对应一个女角色的故事线"},
                {"act": "第三幕：真相", "desc": "发现大boss是校内某位权威人物"},
                {"act": "第四幕：低谷", "desc": "遭遇挫折，某位女角色陷入危机"},
                {"act": "第五幕：决战", "desc": "集结所有伙伴，最终对决"},
                {"act": "终章：日常", "desc": "回归校园，结局根据好感度分支"}
            ],
            "npc_count": 5,
            "social_attrs": ["德行", "智识", "体魄", "魅力"],
            "social_desc": {
                "德行": "领导力与正义感，影响NPC信任度和队伍管理选项",
                "智识": "学识与分析力，影响解谜和知识型对话选项",
                "体魄": "运动与战斗能力，影响物理挑战和战斗选项",
                "魅力": "外在吸引力，直接影响好感度获取倍率"
            },
            "fav_stages": [
                {"name": "陌生人", "cap": 20, "rule": "保持礼貌距离，普通同学关系"},
                {"name": "朋友", "cap": 50, "rule": "友好亲近，可有日常接触"},
                {"name": "暧昧", "cap": 80, "rule": "可有暧昧互动，感情升温"},
                {"name": "恋人", "cap": 100, "rule": "可亲密表达，正式恋爱关系"}
            ]
        }
    },
    # JRPG 角色库（用户保存的NPC模板）
    "jrpg_npc_library": {}
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
