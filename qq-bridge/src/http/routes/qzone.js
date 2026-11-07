// QQ 空间（说说）域的 HTTP 端点。
//
// 这一域有两种调用者，权限完全不同，所以闸门必须分开写：
//
//   · 操作者（控制台 / CLI，凭 consoleToken）：可以授权、撤销、改策略、批准、直接发布；
//   · AI（凭 x-agent-token）：只能提交素材（publish / preview），**不能**覆盖
//     requireApproval、不能碰策略。AI 传了也无效——这一条在 handler 里显式丢弃，
//     不是靠前端不显示按钮来保证的。
//
// 授权状态存在 state/qzone-policy.json，由 src/qzone/index.js 独占读写；
// 这里只做参数搬运与错误映射，不含业务判断。

export function createQzoneRoutes(deps) {
  const { qzoneSvc, agentTokenOk, v2SessionAllowed } = deps;

  /** AI 调用的统一闸门：必须带合法 key + 令牌绑定 + 当前模式允许。 */
  function assertAgentAllowed({ req, sendJson, currentMode, key }) {
    const token = req.headers['x-agent-token'];
    if (!token) return true;
    if (currentMode !== 'reserved2') {
      sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403);
      return false;
    }
    if (!key) {
      sendJson({ ok: false, error: 'AI 调用必须带 key（会话标识），用于校验令牌归属' }, 400);
      return false;
    }
    if (!agentTokenOk(key, token)) {
      sendJson({ ok: false, error: 'agent token 无效' }, 403);
      return false;
    }
    if (!v2SessionAllowed(key)) {
      sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
      return false;
    }
    return true;
  }

  /** 统一回包：服务层返回带 httpStatus 的失败对象，直接照着回。 */
  function reply(sendJson, result, okStatus = 200) {
    if (result?.ok === false) {
      const { httpStatus = 400, ...rest } = result;
      sendJson(rest, httpStatus);
      return;
    }
    sendJson(result ?? { ok: true }, okStatus);
  }

  return [
    {
      // 策略 + 授权状态 + 可用情绪/可见范围：控制台「QQ 空间」页的首屏数据
      method: 'GET',
      path: '/api/qzone/policy',
      async handler({ req, res, url, sendJson }) {
        sendJson({ ok: true, ...qzoneSvc.describePolicy(), pending: qzoneSvc.listPending().length });
        return;
      }
    },
    {
      // 只改策略（配额/时段/可见范围上界…），不触碰授权状态
      method: 'POST',
      path: '/api/qzone/policy',
      async handler({ req, res, url, sendJson, readBody }) {
        const body = await readBody();
        const policy = qzoneSvc.updateSettings(body);
        sendJson({ ok: true, ...policy, pending: qzoneSvc.listPending().length });
        return;
      }
    },
    {
      // 发放授权：这是「授权 AI 发布」这个需求的正门
      method: 'POST',
      path: '/api/qzone/grant',
      async handler({ req, res, url, sendJson, readBody }) {
        const body = await readBody();
        const hours = body.hours === null || body.hours === 0 ? null : Number(body.hours ?? 24);
        if (hours !== null && (!Number.isFinite(hours) || hours < 0 || hours > 24 * 365)) {
          sendJson({ ok: false, error: 'hours 必须是 0（长期）或 0~8760 之间的数字' }, 400);
          return;
        }
        const policy = qzoneSvc.grant({ hours, settings: body.settings ?? {}, actor: 'console' });
        sendJson({ ok: true, ...policy, pending: qzoneSvc.listPending().length });
        return;
      }
    },
    {
      method: 'POST',
      paths: ['/api/qzone/revoke'],
      async handler({ req, res, url, sendJson, readBody }) {
        const body = await readBody();
        const result = qzoneSvc.revoke(String(body.reason ?? ''), { actor: 'console' });
        sendJson({ ok: true, ...result });
        return;
      }
    },
    {
      method: 'GET',
      path: '/api/qzone/pending',
      async handler({ req, res, url, sendJson }) {
        sendJson({ ok: true, pending: qzoneSvc.listPending() });
        return;
      }
    },
    {
      method: 'POST',
      path: '/api/qzone/pending/approve',
      async handler({ req, res, url, sendJson, readBody }) {
        const body = await readBody();
        const id = String(body.id ?? '').trim();
        if (!id) { sendJson({ ok: false, error: 'id 不能为空' }, 400); return; }
        const result = await qzoneSvc.approve(id, { actor: 'console' });
        reply(sendJson, { ...result, ok: result.ok !== false });
        return;
      }
    },
    {
      method: 'POST',
      path: '/api/qzone/pending/reject',
      async handler({ req, res, url, sendJson, readBody }) {
        const body = await readBody();
        const id = String(body.id ?? '').trim();
        if (!id) { sendJson({ ok: false, error: 'id 不能为空' }, 400); return; }
        const result = qzoneSvc.reject(id, String(body.reason ?? ''));
        reply(sendJson, result);
        return;
      }
    },
    {
      method: 'GET',
      path: '/api/qzone/posts',
      async handler({ req, res, url, sendJson }) {
        const limit = Number(url.searchParams.get('limit') ?? 50);
        sendJson({ ok: true, posts: qzoneSvc.listPosts(limit) });
        return;
      }
    },
    {
      // 预览：不占配额、不需要已授权，用来回答"会发成什么样"
      method: 'POST',
      path: '/api/qzone/preview',
      async handler({ req, res, url, sendJson, readBody, currentMode }) {
        const body = await readBody();
        if (!assertAgentAllowed({ req, sendJson, currentMode, key: String(body.key ?? '').trim() })) return;
        const result = await qzoneSvc.preview(body);
        reply(sendJson, result);
        return;
      }
    },
    {
      // AI 起草：把素材写成一条说说。只产文本，不发布、不占发布配额。
      //
      // 为什么要这个端点：聊天模型（low 档）负责"要不要发、发什么方向"，
      // 真正落笔交给这条 high 档的独立调用。两者拆开，成本和延迟互不拖累。
      method: 'POST',
      path: '/api/qzone/draft',
      async handler({ req, res, url, sendJson, readBody, currentMode }) {
        const body = await readBody();
        const isAgent = !!req.headers['x-agent-token'];
        if (isAgent && !assertAgentAllowed({ req, sendJson, currentMode, key: String(body.key ?? '').trim() })) return;
        const result = await qzoneSvc.compose(body, { actor: isAgent ? 'agent' : 'console' });
        reply(sendJson, result);
        return;
      }
    },
    {
      // 发布：AI 与操作者共用同一条通路，差别只在 requireApproval 能不能自己指定
      method: 'POST',
      path: '/api/qzone/publish',
      async handler({ req, res, url, sendJson, readBody, currentMode }) {
        const body = await readBody();
        const isAgent = !!req.headers['x-agent-token'];
        const key = String(body.key ?? '').trim();
        if (isAgent && !assertAgentAllowed({ req, sendJson, currentMode, key })) return;

        // 只有操作者能覆盖审批开关。AI 传 requireApproval=false 会被静默忽略，
        // 因为"免审批"本身就是授权时才该决定的事。
        const requireApproval = isAgent ? undefined : (typeof body.requireApproval === 'boolean' ? body.requireApproval : undefined);

        const result = await qzoneSvc.publish(body, { actor: isAgent ? 'agent' : 'console', key, requireApproval });
        reply(sendJson, result, result?.status === 'pending' ? 202 : 200);
        return;
      }
    }
  ];
}
