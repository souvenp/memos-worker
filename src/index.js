const NOTES_PER_PAGE = 10;
const SESSION_DURATION_SECONDS = 30*86400; // Session 有效期: 30 天
const SESSION_COOKIE = '__session';
export default {
	async fetch(request, env, ctx) {
		return await handleApiRequest(request, env);
	},
};

/**
 * API 请求的统一处理器和路由
 */
async function handleApiRequest(request, env) {
	const { pathname } = new URL(request.url);
	// 公开文件访问路由 (必须在身份验证之前)
	const publicFileMatch = pathname.match(/^\/api\/public\/file\/([a-zA-Z0-9-]+)$/);
	if (publicFileMatch) {
		const publicId = publicFileMatch[1];
		return handlePublicFileRequest(publicId, request, env);
	}

	const tgProxyMatch = pathname.match(/^\/api\/tg-media-proxy\/([^\/]+)$/);
	if (tgProxyMatch) {
		return handleTelegramProxy(request, env);
	}
	// --- Telegram Webhook 路由 ---
	const telegramMatch = pathname.match(/^\/api\/telegram_webhook\/([^\/]+)$/);
	if (request.method === 'POST' && telegramMatch) {
		const secret = telegramMatch[1];
		return handleTelegramWebhook(request, env, secret);
	}

	if (request.method === 'POST' && pathname === '/api/login') {
		return handleLogin(request, env);
	}
	if (request.method === 'POST' && pathname === '/api/logout') {
		return handleLogout(request, env);
	}

	// --- 从这里开始，所有 API 都需要认证 ---
	const session = await isSessionAuthenticated(request, env);
	if (!session) {
		return jsonResponse({ error: 'Unauthorized' }, 401);
	}

	const shareFileMatch = pathname.match(/^\/api\/notes\/(\d+)\/files\/([a-zA-Z0-9-]+)\/share$/);
	if (shareFileMatch && request.method === 'POST') {
		const [, noteId, fileId] = shareFileMatch;
		return handleShareFileRequest(noteId, fileId, request, env);
	}

	// --- START: 更新后的 Docs API 路由 ---
	if (pathname.startsWith('/api/docs')) {
		if (pathname === '/api/docs/tree' && request.method === 'GET') {
			return handleDocsTree(request, env);
		}
		if (pathname === '/api/docs/node' && request.method === 'POST') {
			return handleDocsNodeCreate(request, env);
		}

		// 匹配重命名请求
		const renameMatch = pathname.match(/^\/api\/docs\/node\/([a-zA-Z0-9-]+)\/rename$/);
		if (renameMatch && request.method === 'POST') {
			const nodeId = renameMatch[1];
			return handleDocsNodeRename(request, nodeId, env);
		}

		// 匹配所有 /api/docs/node/:id 相关的请求
		const nodeDetailMatch = pathname.match(/^\/api\/docs\/node\/([a-zA-Z0-9-]+)$/);
		if (nodeDetailMatch) {
			const nodeId = nodeDetailMatch[1];
			if (request.method === 'GET') {
				return handleDocsNodeGet(request, nodeId, env);
			}
			if (request.method === 'PUT') {
				return handleDocsNodeUpdate(request, nodeId, env);
			}
			if (request.method === 'DELETE') {
				return handleDocsNodeDelete(request, nodeId, env);
			}
			if (request.method === 'PATCH') {
				return handleDocsNodeMove(request, nodeId, env);
			}
		}
	}
	// --- END: 更新后的 Docs API 路由 ---

	if (pathname === '/api/settings') {
		if (request.method === 'GET') {
			return handleGetSettings(request, env);
		}
		if (request.method === 'PUT') {
			return handleSetSettings(request, env);
		}
	}
	if (request.method === 'POST' && pathname === '/api/upload/image') {
		return handleStandaloneImageUpload(request, env);
	}
	const imageMatch = pathname.match(/^\/api\/images\/([a-zA-Z0-9-]+)$/);
	if (imageMatch) {
		const imageId = imageMatch[1];
		return handleServeStandaloneImage(imageId, env);
	}
	if (request.method === 'GET' && pathname === '/api/attachments') {
		return handleGetAllAttachments(request, env);
	}
	if (request.method === 'POST' && pathname === '/api/proxy/upload/imgur') {
		return handleImgurProxyUpload(request, env);
	}
	if (pathname === '/api/stats') {
		return handleStatsRequest(request, env);
	}
	if (pathname === '/api/tags') {
		return handleTagsList(request, env);
	}
	const fileMatch = pathname.match(/^\/api\/files\/([^\/]+)\/([^\/]+)$/);
	if (fileMatch) {
		const [, noteId, fileId] = fileMatch;
		return handleFileRequest(noteId, fileId, request, env);
	}
	if (pathname === '/api/notes/timeline') {
		return handleTimelineRequest(request, env);
	}
	if (pathname === '/api/search') {
		return handleSearchRequest(request, env);
	}
	const noteDetailMatch = pathname.match(/^\/api\/notes\/([^\/]+)$/);
	if (noteDetailMatch) {
		const noteId = noteDetailMatch[1];
		return handleNoteDetail(request, noteId, env);
	}

	if (pathname === '/api/notes') {
		return handleNotesList(request, env);
	}
	return new Response('Not Found', { status: 404 });
}

/**
 * 处理统计数据请求
 */
async function handleStatsRequest(request, env) {
	const db = env.DB;
	try {
		const memosCountQuery = db.prepare("SELECT COUNT(*) as total FROM notes");
		const tagsCountQuery = db.prepare("SELECT COUNT(DISTINCT tag_id) as total FROM note_tags");
		const oldestNoteQuery = db.prepare("SELECT MIN(updated_at) as oldest_ts FROM notes");

		// 使用 Promise.all 并行执行所有查询，以获得最佳性能
		const [memosResult, tagsResult, oldestNoteResult] = await Promise.all([
			memosCountQuery.first(),
			tagsCountQuery.first(),
			oldestNoteQuery.first()
		]);

		// 组装最终的 JSON 响应
		const stats = {
			memos: memosResult.total || 0,
			tags: tagsResult.total || 0,
			oldestNoteTimestamp: oldestNoteResult.oldest_ts || null
		};
		return jsonResponse(stats);
	} catch (e) {
		console.error("Stats Error:", e.message);
		return jsonResponse({ error: 'Database Error', message: e.message }, 500);
	}
}

/**
 * 处理时间线数据请求，返回按 年 -> 月 -> 日 结构化的笔记数量统计
 */
async function handleTimelineRequest(request, env) {
	const db = env.DB;
	try {
		const { searchParams } = new URL(request.url);
		const timezone = searchParams.get('timezone') || 'UTC';
		// D1 不直接支持 strftime 或 to_char, 我们需要获取所有创建时间，然后在 JS 中处理
		// 注意：如果笔记数量巨大 (几十万条)，这个查询可能会有性能问题。
		// 对于几千到几万条笔记，这是完全可以接受的。
		const stmt = db.prepare("SELECT updated_at FROM notes ORDER BY updated_at DESC");
		const { results } = await stmt.all();
		if (!results) {
			return jsonResponse({});
		}
		const timezoneFormatter = new Intl.DateTimeFormat('en-US', { // 'en-US' 只是为了格式，不影响结果
			timeZone: timezone,
			year: 'numeric',
			month: 'numeric',
			day: 'numeric',
		});
		// 在 JavaScript 中进行分组统计
		const timeline = {};
		for (const note of results) {
			const date = new Date(note.updated_at);
			const parts = timezoneFormatter.formatToParts(date);
			const year = parseInt(parts.find(p => p.type === 'year').value, 10);
			const month = parseInt(parts.find(p => p.type === 'month').value, 10);
			const day = parseInt(parts.find(p => p.type === 'day').value, 10);

			// 初始化年
			if (!timeline[year]) {
				timeline[year] = { count: 0, months: {} };
			}
			// 初始化月
			if (!timeline[year].months[month]) {
				timeline[year].months[month] = { count: 0, days: {} };
			}
			// 初始化日
			if (!timeline[year].months[month].days[day]) {
				timeline[year].months[month].days[day] = { count: 0 };
			}
			// 递增计数
			timeline[year].count++;
			timeline[year].months[month].count++;
			timeline[year].months[month].days[day].count++;
		}
		return jsonResponse(timeline);
	} catch (e) {
		console.error("Timeline Error:", e.message);
		return jsonResponse({ error: 'Database Error', message: e.message }, 500);
	}
}
/**
 * 处理全文搜索请求，支持分页和叠加筛选条件
 */
async function handleSearchRequest(request, env) {
	const { searchParams } = new URL(request.url);
	const query = searchParams.get('q');

	// 1. 如果搜索查询为空或只包含空格，则将请求委托给 handleNotesList
	if (!query || query.trim().length === 0) {
		// 直接调用 handleNotesList 并返回其结果，实现无缝回退
		return handleNotesList(request, env);
	}
	// 2. 保留对过短查询的检查
	if (query.trim().length < 2) {
		return jsonResponse({ notes: [], hasMore: false });
	}

	// --- 引入分页逻辑 ---
	const page = parseInt(searchParams.get('page') || '1');
	const offset = (page - 1) * NOTES_PER_PAGE;
	const limit = NOTES_PER_PAGE;
	const tagName = searchParams.get('tag');
	const startTimestamp = searchParams.get('startTimestamp');
	const endTimestamp = searchParams.get('endTimestamp');
	const isFavoritesMode = searchParams.get('favorites') === 'true';

	const db = env.DB;
	try {
		let whereClauses = ["notes_fts MATCH ?"];
		let bindings = [query + '*'];
		let joinClause = "";
		if (isFavoritesMode) {
			whereClauses.push("n.is_favorited = 1");
		}
		if (startTimestamp && endTimestamp) {
			const startMs = parseInt(startTimestamp);
			const endMs = parseInt(endTimestamp);
			if (!isNaN(startMs) && !isNaN(endMs)) {
				whereClauses.push("n.updated_at >= ? AND n.updated_at < ?");
				bindings.push(startMs, endMs);
			}
		}
		if (tagName) {
			joinClause = `
                JOIN note_tags nt ON n.id = nt.note_id
                JOIN tags t ON nt.tag_id = t.id
            `;
			whereClauses.push("t.name = ?");
			bindings.push(tagName);
		}

		// 使用子查询方法，先从FTS获取匹配的rowid，再JOIN其他信息
		const ftsQuery = `
            SELECT rowid FROM notes_fts
            WHERE notes_fts MATCH ?
        `;
		const ftsStmt = db.prepare(ftsQuery);
		const { results: ftsResults } = await ftsStmt.bind(query + '*').all();

		if (ftsResults.length === 0) {
			// 如果FTS没有匹配结果，返回空数组
			return jsonResponse({ notes: [], hasMore: false });
		}

		// 获取匹配的note IDs
		const noteIds = ftsResults.map(row => row.rowid);

		// 如果没有匹配的ID，直接返回空结果
		if (noteIds.length === 0) {
			return jsonResponse({ notes: [], hasMore: false });
		}

		// 创建占位符用于IN子句，使用参数绑定避免SQL注入
		const placeholders = noteIds.map(() => '?').join(',');
		let whereClausesForNotes = [`n.id IN (${placeholders})`];
		let noteBindings = [...noteIds]; // 将noteIds作为绑定参数的开头
		let noteJoinClause = "";

		if (isFavoritesMode) {
			whereClausesForNotes.push("n.is_favorited = 1");
		}
		if (startTimestamp && endTimestamp) {
			const startMs = parseInt(startTimestamp);
			const endMs = parseInt(endTimestamp);
			if (!isNaN(startMs) && !isNaN(endMs)) {
				whereClausesForNotes.push("n.updated_at >= ? AND n.updated_at < ?");
				noteBindings.push(startMs, endMs);
			}
		}
		if (tagName) {
			noteJoinClause = `
                JOIN note_tags nt ON n.id = nt.note_id
                JOIN tags t ON nt.tag_id = t.id
            `;
			whereClausesForNotes.push("t.name = ?");
			noteBindings.push(tagName);
		}

		const whereStringForNotes = whereClausesForNotes.join(" AND ");

		const stmt = db.prepare(`
            SELECT n.id, n.content, n.files, n.created_at, n.updated_at, n.is_pinned, n.is_favorited, n.is_archived, n.pics, n.videos
            FROM notes n
            ${noteJoinClause}
            WHERE ${whereStringForNotes}
            ORDER BY n.updated_at DESC
            LIMIT ? OFFSET ?
        `);

		// 绑定参数：首先添加noteIds，然后添加其他条件参数，最后添加分页参数
		const allBindings = [...noteBindings, limit + 1, offset];
		const { results: notesPlusOne } = await stmt.bind(...allBindings).all();

		const hasMore = notesPlusOne.length > limit;
		const notes = notesPlusOne.slice(0, limit);

		notes.forEach(note => {
			if (typeof note.files === 'string') {
				try { note.files = JSON.parse(note.files); } catch (e) { note.files = []; }
			}
			// Ensure pics and videos are also properly parsed
			if (typeof note.pics === 'string') {
				try { note.pics = JSON.parse(note.pics); } catch (e) { note.pics = []; }
			}
			if (typeof note.videos === 'string') {
				try { note.videos = JSON.parse(note.videos); } catch (e) { note.videos = []; }
			}
		});
		return jsonResponse({ notes, hasMore });
	} catch (e) {
		console.error("Search Error:", e.message);
		return jsonResponse({ error: 'Database Error', message: e.message }, 500);
	}
}

/**
 * 获取所有标签及其使用次数
 */
async function handleTagsList(request, env) {
	const db = env.DB;
	try {
		// 使用 LEFT JOIN 和 COUNT 来统计每个标签关联的笔记数量
		// ORDER BY count DESC, name ASC 实现了按数量降序、名称升序的排序
		const stmt = db.prepare(`
            SELECT t.name, COUNT(nt.note_id) as count
            FROM tags t
            LEFT JOIN note_tags nt ON t.id = nt.tag_id
            GROUP BY t.id, t.name
            HAVING count > 0 -- 只返回被使用过的标签
            ORDER BY count DESC, t.name ASC
        `);
		const { results } = await stmt.all();
		return jsonResponse(results);
	} catch (e) {
		console.error("Tags List Error:", e.message);
		return jsonResponse({ error: 'Database Error' }, 500);
	}
}

/**
 * 检查 Session Cookie 是否有效
 */
async function isSessionAuthenticated(request, env) {
	const cookieHeader = request.headers.get('Cookie');
	if (!cookieHeader || !cookieHeader.includes(SESSION_COOKIE)) {
		return null;
	}
	const cookies = cookieHeader.split(';').map(c => c.trim());
	const sessionCookie = cookies.find(c => c.startsWith(`${SESSION_COOKIE}=`));
	if (!sessionCookie) return null;
	const sessionId = sessionCookie.split('=')[1];
	if (!sessionId) return null;
	const session = await env.NOTES_KV.get(`session:${sessionId}`, 'json');
	return session || null;
}

/**
 * 处理登录请求
 */
async function handleLogin(request, env) {
	try {
		const { username, password } = await request.json();
		if (username === env.USERNAME && password === env.PASSWORD) {
			const sessionId = crypto.randomUUID();
			const sessionData = { username, loggedInAt: Date.now() };
			await env.NOTES_KV.put(`session:${sessionId}`, JSON.stringify(sessionData), {
				expirationTtl: SESSION_DURATION_SECONDS,
			});
			const headers = new Headers();
			headers.append('Set-Cookie', `${SESSION_COOKIE}=${sessionId}; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DURATION_SECONDS}`);
			return jsonResponse({ success: true }, 200, headers);
		}
	} catch (e) {
		console.error("Login Error:", e.message);
	}
	return jsonResponse({ error: 'Invalid credentials' }, 401);
}

/**
 * 处理退出登录请求
 */
async function handleLogout(request, env) {
	const cookieHeader = request.headers.get('Cookie');
	if (cookieHeader && cookieHeader.includes(SESSION_COOKIE)) {
		const sessionId = cookieHeader.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))?.[1];
		if (sessionId) {
			await env.NOTES_KV.delete(`session:${sessionId}`);
		}
	}
	const headers = new Headers();
	headers.append('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
	return jsonResponse({ success: true }, 200, headers);
}

/**
 * 从 KV 中获取用户设置。如果 KV 中没有，则返回默认值。
 */
async function handleGetSettings(request, env) {
	const defaultSettings = {
		showSearchBar: true,
		showStatsCard: true,
		showCalendar: true,
		showTags: true,
		showTimeline: true,
		showRightSidebar: true,
		hideEditorInWaterfall: false,
		showHeatmap: true, // 默认显示热力图
		imageUploadDestination: 'local', // 默认使用R2
		imgurClientId: '',
		surfaceColor: '#ffffff',
		surfaceColorDark: '#151f31',
		surfaceOpacity: 1,
		backgroundOpacity: 1, // 默认完全不透明
		backgroundImage: '/bg.jpg',
		backgroundBlur: 0,
		waterfallCardWidth: 320,
		enableDateGrouping: false,
		telegramProxy: false
	};

	let savedSettings = await env.NOTES_KV.get('user_settings', 'json');

	// 如果 KV 中没有设置，则返回默认值
	if (!savedSettings) {
		return jsonResponse(defaultSettings);
	}
	return jsonResponse(savedSettings);
}

/**
 * 将用户设置保存到 KV 中。
 */
async function handleSetSettings(request, env) {
	try {
		const settingsToSave = await request.json();
		await env.NOTES_KV.put('user_settings', JSON.stringify(settingsToSave));
		return jsonResponse({ success: true });
	} catch (e) {
		console.error("Set Settings Error:", e.message);
		return jsonResponse({ error: 'Failed to save settings' }, 500);
	}
}

/**
 * 处理笔记列表的 GET 和 POST
 */
async function handleNotesList(request, env) {
	const db = env.DB;

	try {
		switch (request.method) {
			case 'GET': {
				const url = new URL(request.url);
				const page = parseInt(url.searchParams.get('page') || '1');
				const offset = (page - 1) * NOTES_PER_PAGE;
				const limit = NOTES_PER_PAGE;

				const startTimestamp = url.searchParams.get('startTimestamp');
				const endTimestamp = url.searchParams.get('endTimestamp');
				const tagName = url.searchParams.get('tag');
				const isFavoritesMode = url.searchParams.get('favorites') === 'true';
				const isArchivedMode = url.searchParams.get('archived') === 'true';

				let whereClauses = [];
				let bindings = [];
				let joinClause = "";

				if (isArchivedMode) {
					whereClauses.push("n.is_archived = 1");
				} else {
					// 默认（包括收藏夹）都应该排除已归档的
					whereClauses.push("n.is_archived = 0");
				}

				if (startTimestamp && endTimestamp) {
					// 将字符串时间戳转换为数字
					const startMs = parseInt(startTimestamp);
					const endMs = parseInt(endTimestamp);

					if (!isNaN(startMs) && !isNaN(endMs)) {
						whereClauses.push("updated_at >= ? AND updated_at < ?");
						bindings.push(startMs, endMs);
					}
				}
				if (tagName) {
					joinClause = `
                    JOIN note_tags nt ON n.id = nt.note_id
                    JOIN tags t ON nt.tag_id = t.id
                `;
					whereClauses.push("t.name = ?");
					bindings.push(tagName);
				}
				if (isFavoritesMode) {
					whereClauses.push("n.is_favorited = 1");
				}
				const whereClause = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

				const query = `
                SELECT n.* FROM notes n
                ${joinClause}
                ${whereClause}
                ORDER BY n.is_pinned DESC, n.updated_at DESC
                LIMIT ? OFFSET ?
            `;

				// 将分页参数添加到 bindings 数组的末尾
				bindings.push(limit + 1, offset);

				const notesStmt = db.prepare(query);
				const { results: notesPlusOne } = await notesStmt.bind(...bindings).all();

				const hasMore = notesPlusOne.length > limit;
				const notes = notesPlusOne.slice(0, limit);

				notes.forEach(note => {
					if (typeof note.files === 'string') {
						try { note.files = JSON.parse(note.files); } catch (e) { note.files = []; }
					}
				});

				return jsonResponse({ notes, hasMore });
			}

			case 'POST': {
				const formData = await request.formData();
				const content = formData.get('content')?.toString() || '';
				const files = formData.getAll('file');

				if (!content.trim() && files.every(f => !f.name)) {
					return jsonResponse({ error: 'Content or file is required.' }, 400);
				}

				const now = Date.now();
				const filesMeta = [];

				// 【核心修改】在插入数据库前，先提取图片 URL
				const picUrls = extractImageUrls(content);

				// 【核心修改】在 INSERT 语句中加入新的 pics 字段
				const insertStmt = db.prepare(
					"INSERT INTO notes (content, files, is_pinned, created_at, updated_at, pics) VALUES (?, ?, 0, ?, ?, ?) RETURNING id"
				);
				// 先用一个空的 files 数组插入
				// 【核心修改】将提取出的 picUrls 绑定到 SQL 语句中
				const { id: noteId } = await insertStmt.bind(content, "[]", now, now, picUrls).first();
				if (!noteId) {
					throw new Error("Failed to create note and get ID.");
				}

				// --- 【重要逻辑调整】现在上传的文件，只有非图片类型才算作 "附件" (files) ---
				for (const file of files) {
					// 只有当文件存在，并且 MIME 类型不是图片时，才将其添加到 filesMeta
					if (file.name && file.size > 0 && !file.type.startsWith('image/')) {
						const fileId = crypto.randomUUID();
						await env.NOTES_R2_BUCKET.put(`${noteId}/${fileId}`, file.stream());
						filesMeta.push({ id: fileId, name: file.name, size: file.size, type: file.type });
					}
				}

				// 如果有非图片附件，再更新数据库中的 files 字段
				if (filesMeta.length > 0) {
					const updateFilesStmt = db.prepare("UPDATE notes SET files = ? WHERE id = ?");
					await updateFilesStmt.bind(JSON.stringify(filesMeta), noteId).run();
				}

				await processNoteTags(db, noteId, content);
				// 获取完整的笔记返回给前端
				const newNote = await db.prepare("SELECT * FROM notes WHERE id = ?").bind(noteId).first();
				if (typeof newNote.files === 'string') {
					newNote.files = JSON.parse(newNote.files);
				}

				return jsonResponse(newNote, 201);
			}
		}
	} catch (e) {
		console.error("D1 Error:", e.message, e.cause);
		return jsonResponse({ error: 'Database Error', message: e.message }, 500);
	}
}

/**
 * 处理单条笔记的 PUT 和 DELETE
 */
async function handleNoteDetail(request, noteId, env) {
	const db = env.DB;
	const id = parseInt(noteId);
	if (isNaN(id)) {
		return new Response('Invalid Note ID', { status: 400 });
	}

	try {
		// 首先获取现有笔记，用于文件删除和返回数据
		let existingNote = await db.prepare("SELECT * FROM notes WHERE id = ?").bind(id).first();
		if (!existingNote) {
			return new Response('Not Found', { status: 404 });
		}
		// 确保 files 字段是数组
		try {
			if (typeof existingNote.files === 'string') {
				existingNote.files = JSON.parse(existingNote.files);
			}
		} catch(e) {
			existingNote.files = [];
		}

		switch (request.method) {
			case 'PUT': {
				const formData = await request.formData();
				const shouldUpdateTimestamp = formData.get('update_timestamp') !== 'false';

				if (formData.has('content')) {
					const content = formData.get('content')?.toString() ?? existingNote.content;
					let currentFiles = existingNote.files;

					// --- 现在的文件处理只关心非图片附件 ---
					// 处理附件删除 (逻辑不变，因为它操作的是 files 字段)
					const filesToDelete = JSON.parse(formData.get('filesToDelete') || '[]');
					if (filesToDelete.length > 0) {
						const r2KeysToDelete = filesToDelete.map(fileId => `${id}/${fileId}`);
						await env.NOTES_R2_BUCKET.delete(r2KeysToDelete);
						currentFiles = currentFiles.filter(file => !filesToDelete.includes(file.id));
					}

					// 处理新附件上传
					const newFiles = formData.getAll('file');
					for (const file of newFiles) {
						// 只有当文件存在，并且不是图片时，才作为附件处理
						if (file.name && file.size > 0 && !file.type.startsWith('image/')) {
							const fileId = crypto.randomUUID();
							await env.NOTES_R2_BUCKET.put(`${id}/${fileId}`, file.stream());
							currentFiles.push({ id: fileId, name: file.name, size: file.size, type: file.type });
						}
					}

					// 在更新数据库前，提取新的图片 URL 列表
					const picUrls = extractImageUrls(content);
					const newTimestamp = shouldUpdateTimestamp ? Date.now() : existingNote.updated_at;
					// 在 UPDATE 语句中加入 pics 字段的更新
					const stmt = db.prepare(
						"UPDATE notes SET content = ?, files = ?, updated_at = ?, pics = ? WHERE id = ?"
					);
					await stmt.bind(content, JSON.stringify(currentFiles), newTimestamp, picUrls, id).run();
					await processNoteTags(db, id, content);
				}

				if (formData.has('isPinned')) { // --- 这是置顶状态的更新 ---
					const isPinned = formData.get('isPinned') === 'true' ? 1 : 0;
					const stmt = db.prepare("UPDATE notes SET is_pinned = ? WHERE id = ?");
					await stmt.bind(isPinned, id).run();
				}
				if (formData.has('isFavorited')) {
					const isFavorited = formData.get('isFavorited') === 'true' ? 1 : 0;
					const stmt = db.prepare("UPDATE notes SET is_favorited = ? WHERE id = ?");
					await stmt.bind(isFavorited, id).run();
				}
				if (formData.has('is_archived')) {
					const isArchived = formData.get('is_archived') === 'true' ? 1 : 0;
					const stmt = db.prepare("UPDATE notes SET is_archived = ? WHERE id = ?");
					await stmt.bind(isArchived, id).run();
				}

				const updatedNote = await db.prepare("SELECT * FROM notes WHERE id = ?").bind(id).first();
				if (typeof updatedNote.files === 'string') {
					updatedNote.files = JSON.parse(updatedNote.files);
				}
				return jsonResponse(updatedNote);
			}

			case 'DELETE': {
				// 删除 R2 中的文件
				if (existingNote.files && existingNote.files.length > 0) {
					const r2KeysToDelete = existingNote.files
						.filter(file => file.id)
						.map(file => `${id}/${file.id}`);
					if (r2KeysToDelete.length > 0) {
						await env.NOTES_R2_BUCKET.delete(r2KeysToDelete);
					}
				}
				// 从数据库中删除笔记
				await db.prepare("DELETE FROM notes WHERE id = ?").bind(id).run();
				return new Response(null, { status: 204 });
			}
		}
	} catch (e) {
		console.error("D1 Error:", e.message, e.cause);
		return jsonResponse({ error: 'Database Error', message: e.message }, 500);
	}
}

async function handleFileRequest(noteId, fileId, request, env) {
	const db = env.DB;
	const id = parseInt(noteId);
	if (isNaN(id)) {
		return new Response('Invalid Note ID', { status: 400 });
	}

	// 尝试从数据库获取元数据
	const note = await db.prepare("SELECT files FROM notes WHERE id = ?").bind(id).first();

	// 【核心修改】即使 note 不存在或 files 为空，我们也不立即返回 404，
	// 因为图片可能只记录在 pics 字段中。

	let files = [];
	if (note && typeof note.files === 'string') {
		try {
			files = JSON.parse(note.files);
		} catch (e) {
			// JSON 解析失败则忽略
		}
	}

	const fileMeta = files.find(f => f.id === fileId);

	// 尝试从 R2 获取文件对象
	const object = await env.NOTES_R2_BUCKET.get(`${id}/${fileId}`);
	if (object === null) {
		// 如果 R2 中确实没有这个文件，才返回 404
		return new Response('File not found in storage', { status: 404 });
	}

	const headers = new Headers();
	object.writeHttpMetadata(headers); // 从 R2 对象中写入元数据（如 Content-Type）
	headers.set('etag', object.httpEtag);
	headers.set('Cache-Control', 'public, max-age=86400, immutable');

	// --- 根据是否存在 fileMeta 来决定如何设置 headers ---
	if (fileMeta) {
		// 【情况一：元数据存在】这是标准文件或旧的图片，按原逻辑处理
		const contentType = fileMeta.type || 'application/octet-stream';
		const fileExtension = fileMeta.name.split('.').pop().toLowerCase();
		const textLikeExtensions = ['yml', 'yaml', 'md', 'log', 'toml', 'sh', 'py', 'js', 'json', 'css', 'html'];

		if (contentType.startsWith('text/') || textLikeExtensions.includes(fileExtension)) {
			headers.set('Content-Type', 'text/plain; charset=utf-8');
		} else {
			headers.set('Content-Type', contentType);
		}

		const isPreview = new URL(request.url).searchParams.get('preview') === 'true';
		const disposition = isPreview ? 'inline' : 'attachment';
		headers.set('Content-Disposition', `${disposition}; filename="${encodeURIComponent(fileMeta.name)}"`);
	} else {
		// 【情况二：元数据不存在】这是新的 Telegram 图片，我们只确保它能被浏览器正确显示
		// Content-Type 已经通过 object.writeHttpMetadata(headers) 从 R2 中设置好了，
		// 这通常足够让浏览器正确渲染图片。
		// 我们将其设置为 inline，确保它在 <img> 标签中能显示而不是被下载。
		headers.set('Content-Disposition', 'inline');
	}

	return new Response(object.body, { headers });
}
/**
 *  将 Telegram 的格式化实体 (entities) 转换为 Markdown 文本
 *
 * @param {string} text 原始文本
 * @param {Array<object>} entities 从 Telegram API 收到的标签数组。
 * @returns {string} 格式化后的、高度兼容的 Markdown 文本。
 */
function telegramEntitiesToMarkdown(text, entities = []) {
	if (!entities || entities.length === 0) {
		return text;
	}

	// 优先级决定了标签的嵌套顺序。数字越小，越在外层。
	const tagPriority = {
		'text_link': 10,
		'bold': 20,
		'italic': 30, // 使用 _ 作为斜体标记，避免与 ** 的 * 冲突
		'underline': 40,
		'strikethrough': 50,
		'spoiler': 60,
		'code': 70,
		'pre': 80
	};
	const mods = Array.from({ length: text.length + 1 }, () => ({ openTags: [], closeTags: [] }));
	entities.forEach(entity => {
		const { type, offset, length, url, language } = entity;
		const endOffset = offset + length;
		const priority = tagPriority[type] || 100;
		let startTag = '', endTag = '';
		switch (type) {
			case 'bold':          startTag = '**'; endTag = '**'; break;
			case 'italic':        startTag = '_';  endTag = '_';  break;
			case 'underline':     startTag = '__'; endTag = '__'; break;
			case 'strikethrough': startTag = '~~'; endTag = '~~'; break;
			case 'spoiler':       startTag = '||'; endTag = '||'; break;
			case 'code':          startTag = '`';  endTag = '`';  break;
			case 'text_link':
				startTag = '[';
				const encodedUrl = url.replace(/\(/g, '%28').replace(/\)/g, '%29');
				endTag = `](${encodedUrl})`;
				break;
			case 'pre':
				startTag = `\`\`\`${language || ''}\n`; endTag = '\n```'; break;
		}

		if (startTag) {
			mods[offset].openTags.push({ tag: startTag, priority });
			mods[endOffset].closeTags.push({ tag: endTag, priority });
		}
	});

	let result = '';
	let lastIndex = 0;
	const adjacentSensitiveTags = ['**', '_', '__', '~~', '||', '`'];

	for (let i = 0; i <= text.length; i++) {
		const mod = mods[i];
		if (mod.openTags.length === 0 && mod.closeTags.length === 0) {
			continue;
		}
		result += text.substring(lastIndex, i);
		//   - 闭合标签按优先级从高到低（内层先关）
		//   - 起始标签按优先级从低到高（外层先开）
		const closeTags = mod.closeTags.sort((a, b) => b.priority - a.priority);
		const openTags = mod.openTags.sort((a, b) => a.priority - b.priority);

		closeTags.forEach(({ tag }) => {
			if (adjacentSensitiveTags.includes(tag) && result.endsWith(tag)) {
				result += '\u200B'; // 插入零宽度空格
			}
			result += tag;
		});

		openTags.forEach(({ tag }) => {
			if (adjacentSensitiveTags.includes(tag) && result.endsWith(tag)) {
				result += '\u200B'; // 插入零宽度空格
			}
			result += tag;
		});

		lastIndex = i;
	}

	if (lastIndex < text.length) {
		result += text.substring(lastIndex);
	}
	result = result.replace(
		/\*\*((?:(?:\p{Emoji}|\p{Emoji_Component})+))\*\*/gu,
		'$1'
	);
	result = result.replace(/\*\*(\s+)\*\*/g, '$1');
	result = result.replace(/\*\*(\s+)(.*?)\*\*/g, '$1**$2**');
	return result;
}

/**
 * 代理 Telegram 媒体文件请求。
 * 接收一个 file_id，实时获取临时下载链接并重定向用户。
 */
async function handleTelegramProxy(request, env) {
	const { pathname } = new URL(request.url);
	const match = pathname.match(/^\/api\/tg-media-proxy\/([^\/]+)$/);

	if (!match || !match[1]) {
		return new Response('Invalid file_id', { status: 400 });
	}

	const fileId = match[1];
	const botToken = env.TELEGRAM_BOT_TOKEN;

	if (!botToken) {
		console.error("TELEGRAM_BOT_TOKEN secret is not set.");
		return new Response('Bot not configured', { status: 500 });
	}

	try {
		// 1. 调用 getFile API
		const getFileUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`;
		const fileInfoRes = await fetch(getFileUrl);
		const fileInfo = await fileInfoRes.json();

		if (!fileInfo.ok) {
			console.error(`Telegram getFile API error for file_id ${fileId}:`, fileInfo.description);
			return new Response(`Telegram API error: ${fileInfo.description}`, { status: 502 }); // 502 Bad Gateway
		}

		// 2. 构建临时的下载链接
		const temporaryDownloadUrl = `https://api.telegram.org/file/bot${botToken}/${fileInfo.result.file_path}`;

		// 3. 返回 302 重定向
		return Response.redirect(temporaryDownloadUrl, 302);

	} catch (e) {
		console.error("Telegram Proxy Error:", e.message);
		return new Response('Failed to proxy Telegram media', { status: 500 });
	}
}

/**
 * - 处理来自 Telegram Bot 的 Webhook 请求
 * - 视频：保存 file_id，并在正文中嵌入指向 Worker 代理的链接，实现动态播放。
 * - 图片/文件：仍然二次上传到 R2，保证永久可用。
 */
async function handleTelegramWebhook(request, env, secret) {
	if (!env.TELEGRAM_WEBHOOK_SECRET || secret !== env.TELEGRAM_WEBHOOK_SECRET) {
		return new Response('Unauthorized', { status: 401 });
	}
	let chatId = null;
	const botToken = env.TELEGRAM_BOT_TOKEN;
	try {
		const update = await request.json();
		const message = update.message || update.channel_post;
		if (!message) {
			return new Response('OK', { status: 200 });
		}

		const authorizedIdsStr = env.AUTHORIZED_TELEGRAM_IDS;
		if (!authorizedIdsStr) {
			console.error("安全警告：AUTHORIZED_TELEGRAM_IDS 环境变量未设置。");
			return new Response('OK', { status: 200 });
		}
		chatId = message.chat.id;
		const senderId = message.from?.id;
		if (!senderId || authorizedIdsStr != senderId.toString()) {
			console.log(`已阻止来自未授权或未知用户 ${senderId || ''} 的请求。`);
			return new Response('OK', { status: 200 });
		}

		const db = env.DB;
		const bucket = env.NOTES_R2_BUCKET;
		if (!botToken) {
			console.error("TELEGRAM_BOT_TOKEN secret is not set.");
			return new Response('Bot not configured', { status: 500 });
		}

		const text = message.text || message.caption || '';
		const entities = message.entities || message.caption_entities || [];
		const contentFromTelegram = telegramEntitiesToMarkdown(text, entities);

		let forwardInfo = '';
		if (message.forward_from_chat) {
			const chat = message.forward_from_chat;
			const title = chat.title || 'a channel';
			if (chat.username) {
				const channelUrl = `https://t.me/${chat.username}`;
				forwardInfo = `*Forwarded from [${title}](${channelUrl})*`;
			} else {
				forwardInfo = `*Forwarded from ${title}*`;
			}
		} else if (message.forward_from) {
			const fromName = `${message.forward_from.first_name || ''} ${message.forward_from.last_name || ''}`.trim();
			forwardInfo = `*Forwarded from ${fromName}*`;
		}

		let replyMarkdown = '';
		if (message.reply_to_message) {
			const originalMessage = message.reply_to_message;
			const originalText = originalMessage.text || originalMessage.caption || '';
			const originalEntities = originalMessage.entities || originalMessage.caption_entities || [];
			const originalContentMarkdown = telegramEntitiesToMarkdown(originalText, originalEntities);
			if (originalContentMarkdown.trim()) {
				replyMarkdown = originalContentMarkdown.trim().split('\n').map(line => `> ${line}`).join('\n');
			}
		}

		const photo = message.photo ? message.photo[message.photo.length - 1] : null;
		const document = message.document;
		const video = message.video;

		if (!contentFromTelegram.trim() && !photo && !document && !video) {
			return new Response('OK', { status: 200 });
		}
		const defaultSettings = { telegramProxy: false };
		let userSettings = await env.NOTES_KV.get('user_settings', 'json');
		if (!userSettings) {
			userSettings = defaultSettings;
		}
		const settings = { ...defaultSettings, ...userSettings };
		const now = Date.now();
		let filesMeta = [];
		let picObjects = [];
		let videoObjects = [];
		let mediaEmbeds = [];

		const insertStmt = db.prepare("INSERT INTO notes (content, files, is_pinned, created_at, updated_at, pics, videos) VALUES (?, ?, 0, ?, ?, ?, ?) RETURNING id");
		const { id: noteId } = await insertStmt.bind('', '[]', now, now, '[]', '[]').first();
		if (!noteId) {
			throw new Error("无法在数据库中创建笔记记录。");
		}

		// 图片处理（保持二次上传）
		if (photo) {
			const getFileUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${photo.file_id}`;
			const fileInfoRes = await fetch(getFileUrl);
			const fileInfo = await fileInfoRes.json();
			if (!fileInfo.ok) throw new Error(`Telegram getFile API 错误 (photo): ${fileInfo.description}`);
			const filePath = fileInfo.result.file_path;
			const fileName = `photo_${message.message_id}.${(filePath.split('.').pop() || 'jpg')}`;
			const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
			const fileRes = await fetch(downloadUrl);
			if (!fileRes.ok) throw new Error("从 Telegram 下载图片失败。");
			const fileId = crypto.randomUUID();
			await bucket.put(`${noteId}/${fileId}`, fileRes.body);
			const internalFileUrl = `/api/files/${noteId}/${fileId}`;

			picObjects.push(internalFileUrl); // 为了兼容性，图片直接存 URL 字符串
			mediaEmbeds.push(`![${fileName}](${internalFileUrl})`);
		}

		if (video) {
			if (settings.telegramProxy) {
				// --- 代理模式 ---
				const proxyUrl = `/api/tg-media-proxy/${video.file_id}`;
				videoObjects.push(proxyUrl);
				mediaEmbeds.push(`<video src="${proxyUrl}" width="100%" controls muted></video>`);
			} else {
				// --- 二次上传模式 ---
				const getFileUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${video.file_id}`;
				const fileInfoRes = await fetch(getFileUrl);
				const fileInfo = await fileInfoRes.json();
				if (!fileInfo.ok) throw new Error(`Telegram getFile API 错误 (video): ${fileInfo.description}`);
				const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${fileInfo.result.file_path}`;
				const fileRes = await fetch(downloadUrl);
				if (!fileRes.ok) throw new Error("从 Telegram 下载视频失败。");
				const fileId = crypto.randomUUID();
				await bucket.put(`${noteId}/${fileId}`, fileRes.body);
				const internalFileUrl = `/api/files/${noteId}/${fileId}`;
				videoObjects.push(internalFileUrl);
				mediaEmbeds.push(`<video src="${internalFileUrl}" width="100%" controls muted></video>`);
			}
		}

		// 文件处理（根据设置决定模式）
		if (document) {
			if (settings.telegramProxy) {
				// --- 代理模式 ---
				// 注意：代理文件时，我们无法在笔记中直接展示它，只能存一个元信息
				filesMeta.push({
					type: 'telegram_document', // 特殊类型
					file_id: document.file_id,
					name: document.file_name,
					size: document.file_size
				});
				// 可以在正文加一个占位符，但这需要前端支持渲染
				// finalContent += `\n\n[Proxy File: ${document.file_name}]`;
			} else {
				// --- 二次上传模式 ---
				const getFileUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${document.file_id}`;
				const fileInfoRes = await fetch(getFileUrl);
				const fileInfo = await fileInfoRes.json();
				if (!fileInfo.ok) throw new Error(`Telegram getFile API 错误 (document): ${fileInfo.description}`);
				const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${fileInfo.result.file_path}`;
				const fileRes = await fetch(downloadUrl);
				if (!fileRes.ok) throw new Error("从 Telegram 下载文件失败。");
				const fileId = crypto.randomUUID();
				await bucket.put(`${noteId}/${fileId}`, fileRes.body);
				filesMeta.push({
					id: fileId,
					name: document.file_name,
					size: document.file_size,
					type: document.mime_type || 'application/octet-stream'
				});
			}
		}

		const contentParts = [];
		if (forwardInfo) contentParts.push(forwardInfo);
		if (mediaEmbeds.length > 0) contentParts.push(mediaEmbeds.join('\n'));
		if (replyMarkdown) contentParts.push(replyMarkdown);
		if (contentFromTelegram.trim()) contentParts.push(contentFromTelegram.trim());

		let finalContent = "#TG " + contentParts.join('\n\n');

		const updateStmt = db.prepare("UPDATE notes SET content = ?, files = ?, pics = ?, videos = ? WHERE id = ?");
		await updateStmt.bind(
			finalContent,
			JSON.stringify(filesMeta),
			JSON.stringify(picObjects),
			JSON.stringify(videoObjects), // [新增] 绑定 videoObjects
			noteId
		).run();

		await processNoteTags(db, noteId, finalContent);
		await sendTelegramMessage(chatId, `✅ 笔记已保存！ (ID: ${noteId})`, botToken);

	} catch (e) {
		console.error("Telegram Webhook Error:", e.message);
		if (chatId && botToken) {
			await sendTelegramMessage(chatId, `❌ 保存笔记时出错: ${e.message}`, botToken);
		}
	}
	return new Response('OK', { status: 200 });
}
/**
 * 发送消息到指定的 Telegram 聊天
 * @param {string | number} chatId 聊天 ID
 * @param {string} text 要发送的文本
 * @param {string} botToken 机器人 Token
 */
async function sendTelegramMessage(chatId, text, botToken) {
	const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
	const payload = {
		chat_id: chatId,
		text: text,
		parse_mode: 'Markdown' // 也可以使用 'HTML'
	};

	try {
		const response = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(payload)
		});
		if (!response.ok) {
			const errorBody = await response.json();
			console.error(`Failed to send Telegram message: ${errorBody.description}`);
		}
	} catch (error) {
		console.error(`Error sending Telegram message: ${error.message}`);
	}
}


function extractImageUrls(content) {
	// 正则表达式：全局匹配所有 Markdown 图片语法 ![alt](url)
	// 关键点：
	// 1. /g flag - 确保能找到文中所有的图片，而不仅仅是第一个
	// 2. \!\[.*?\] - 非贪婪地匹配 alt 文本部分，处理各种复杂的 alt 内容
	// 3. \((.*?)\) - 捕获组( ... )，非贪婪地捕获括号内的 URL
	const regex = /!\[.*?\]\((.*?)\)/g;

	// 使用 String.prototype.matchAll() 来获取所有匹配项和捕获组
	// 它返回一个迭代器，我们用 Array.from 将其转换为数组
	const matches = Array.from(content.matchAll(regex));

	// 提取每个匹配项的第一个捕获组（也就是 URL）
	const urls = matches.map(match => match[1]);

	// 返回一个 JSON 字符串数组，以便直接存入 D1 的 TEXT 字段
	return JSON.stringify(urls);
}
/**
 * 处理笔记的标签逻辑，过滤掉 URL 中的 #
 */
async function processNoteTags(db, noteId, content) {
	const plainTextContent = content.replace(/<[^>]*>/g, '');
	// 1. 定义两个正则表达式：一个用于标签，一个用于 URL
	const tagRegex = /#([\p{L}\p{N}_-]+)/gu;
	const urlRegex = /(https?:\/\/[^\s"']*[^\s"'.?,!])/g;

	// 2. 将内容分割成“普通文本”和“链接文本”的交替数组
	const segments = plainTextContent.split(urlRegex);
	let allTags = [];

	// 3. 遍历所有片段
	segments.forEach(segment => {
		// 4. 关键：只在【非链接】的文本片段中查找标签
		//    我们通过重新测试来判断它是否是 URL
		if (!/^(https?:\/\/[^\s"']*[^\s"'.?,!])/.test(segment)) {
			const matchedInSegment = [...segment.matchAll(tagRegex)].map(match => match[1].toLowerCase());
			allTags.push(...matchedInSegment);
		}
	});

	// 5. 将从所有安全片段中找到的标签进行去重
	const uniqueTags = [...new Set(allTags)];

	const statements = [];
	statements.push(db.prepare("DELETE FROM note_tags WHERE note_id = ?").bind(noteId));

	if (uniqueTags.length > 0) {
		for (const tagName of uniqueTags) {
			await db.prepare("INSERT OR IGNORE INTO tags (name) VALUES (?)").bind(tagName).run();
			const tag = await db.prepare("SELECT id FROM tags WHERE name = ?").bind(tagName).first();
			if (tag) {
				statements.push(
					db.prepare("INSERT OR IGNORE INTO note_tags (note_id, tag_id) VALUES (?, ?)")
						.bind(noteId, tag.id)
				);
			}
		}
	}
	if (statements.length > 0) {
		await db.batch(statements);
	}
}
/**
 * 处理独立的图片上传请求 (从粘贴操作)
 * 将图片存入 R2 的一个通用 'uploads' 文件夹中
 */
async function handleStandaloneImageUpload(request, env) {
	try {
		const formData = await request.formData();
		const file = formData.get('file');

		if (!file || !file.name || file.size === 0) {
			return jsonResponse({ error: 'A file is required for upload.' }, 400);
		}

		const imageId = crypto.randomUUID();
		// 我们将独立上传的图片统一放到一个 'uploads/' 目录下，与笔记附件分开
		const r2Key = `uploads/${imageId}`;

		// 将文件流上传到 R2
		await env.NOTES_R2_BUCKET.put(r2Key, file.stream(), {
			httpMetadata: { contentType: file.type },
		});

		// 返回一个可用于访问此图片的内部 URL
		// 这个 URL 对应我们下面创建的 handleServeStandaloneImage 函数的路由
		const imageUrl = `/api/images/${imageId}`;
		return jsonResponse({ success: true, url: imageUrl });

	} catch (e) {
		console.error("Standalone Image Upload Error:", e.message);
		return jsonResponse({ error: 'Upload failed', message: e.message }, 500);
	}
}

/**
 * 通过 Worker 代理上传图片到 Imgur
 */
async function handleImgurProxyUpload(request, env) {
	try {
		const formData = await request.formData();
		// 【注意】从前端获取 Client ID，而不是硬编码在后端
		const clientId = formData.get('clientId');
		if (!clientId) {
			return jsonResponse({ error: 'Imgur Client ID is required.' }, 400);
		}

		// Imgur 需要 'image' 字段
		const imageFile = formData.get('file');
		const imgurFormData = new FormData();
		imgurFormData.append('image', imageFile);

		const imgurResponse = await fetch('https://api.imgur.com/3/image', {
			method: 'POST',
			headers: {
				'Authorization': `Client-ID ${clientId}`,
			},
			body: imgurFormData,
		});

		if (!imgurResponse.ok) {
			const errorBody = await imgurResponse.json();
			throw new Error(`Imgur API responded with status ${imgurResponse.status}: ${errorBody.data.error}`);
		}

		const result = await imgurResponse.json();

		if (!result.success) {
			throw new Error('Imgur API returned a failure response.');
		}

		return jsonResponse({ success: true, url: result.data.link });

	} catch (e) {
		console.error("Imgur Proxy Error:", e.message);
		return jsonResponse({ error: 'Imgur upload failed via proxy', message: e.message }, 500);
	}
}

async function handleGetAllAttachments(request, env) {
	const db = env.DB;
	const url = new URL(request.url);
	const page = parseInt(url.searchParams.get('page') || '1');
	const limit = 20; // 每次加载20条附件
	const offset = (page - 1) * limit;

	try {
		// 使用 Common Table Expression (CTE) 和 UNION ALL 来构建一个高效的单一查询
		const query = `
            WITH combined_attachments AS (
                SELECT
                    n.id AS noteId, n.updated_at AS timestamp, 'image' AS type,
                    json_each.value AS url, NULL AS name, NULL AS size, NULL AS id
                FROM notes n, json_each(n.pics) AS json_each
                WHERE json_valid(n.pics) AND json_array_length(n.pics) > 0

                UNION ALL

                SELECT
                    n.id AS noteId, n.updated_at AS timestamp, 'video' AS type,
                    json_each.value AS url, NULL AS name, NULL AS size, NULL AS id
                FROM notes n, json_each(n.videos) AS json_each
                WHERE json_valid(n.videos) AND json_array_length(n.videos) > 0

                UNION ALL

                SELECT
                    n.id AS noteId, n.updated_at AS timestamp, 'file' AS type,
                    NULL AS url, json_extract(json_each.value, '$.name') AS name,
                    json_extract(json_each.value, '$.size') AS size,
                    json_extract(json_each.value, '$.id') AS id
                FROM notes n, json_each(n.files) AS json_each
                WHERE json_valid(n.files) AND json_array_length(n.files) > 0
            )
            SELECT * FROM combined_attachments
            ORDER BY timestamp DESC
            LIMIT ? OFFSET ?;
        `;

		// 为了判断是否有更多页面，我们请求 limit + 1 条记录
		const stmt = db.prepare(query);
		const { results: attachmentsPlusOne } = await stmt.bind(limit + 1, offset).all();

		const hasMore = attachmentsPlusOne.length > limit;
		const attachments = attachmentsPlusOne.slice(0, limit);

		return jsonResponse({
			attachments: attachments,
			hasMore: hasMore
		});

	} catch (e) {
		console.error("Get All Attachments Error:", e.message);
		return jsonResponse({ error: 'Database Error', message: e.message }, 500);
	}
}

/**
 * 根据 ID 从 R2 中提供（服务）一个独立上传的图片
 * @param {string} imageId The UUID of the image.
 * @param {object} env The Worker environment/bindings.
 * @returns {Promise<Response>}
 */
async function handleServeStandaloneImage(imageId, env) {
	const r2Key = `uploads/${imageId}`;
	const object = await env.NOTES_R2_BUCKET.get(r2Key);

	if (object === null) {
		return new Response('File not found', { status: 404 });
	}

	const headers = new Headers();
	object.writeHttpMetadata(headers);
	headers.set('etag', object.httpEtag);
	// 设置长时间的浏览器缓存，因为这些图片内容是不可变的
	headers.set('Cache-Control', 'public, max-age=31536000, immutable');

	return new Response(object.body, { headers });
}


/**
 * 从扁平的节点列表中构建层级树结构
 * @param {Array<object>} nodes - 从数据库查询出的节点数组
 * @param {string|null} parentId - 当前要查找的父节点ID
 * @returns {Array<object>} - 构建好的层级树数组
 */
function buildTree(nodes, parentId = null) {
	const tree = [];
	nodes
		.filter(node => node.parent_id === parentId)
		.forEach(node => {
			const children = buildTree(nodes, node.id);
			if (children.length > 0) {
				node.children = children;
			}
			tree.push(node);
		});
	return tree;
}

/**
 * GET /api/docs/tree - 获取所有文档节点并返回树状结构
 */
async function handleDocsTree(request, env) {
	try {
		const stmt = env.DB.prepare("SELECT id, type, title, parent_id FROM nodes ORDER BY title ASC");
		const { results } = await stmt.all();
		const tree = buildTree(results, null);
		return jsonResponse(tree);
	} catch (e) {
		console.error("Docs Tree Error:", e.message);
		return jsonResponse({ error: 'Database Error', message: e.message }, 500);
	}
}

/**
 * GET /api/docs/node/:id - 获取单个文档节点的内容
 */
async function handleDocsNodeGet(request, nodeId, env) {
	try {
		const stmt = env.DB.prepare("SELECT id, type, title, content FROM nodes WHERE id = ?");
		const node = await stmt.bind(nodeId).first();
		if (!node) {
			return jsonResponse({ error: 'Not Found' }, 404);
		}
		return jsonResponse(node);
	} catch (e) {
		console.error(`Docs Get Node Error (id: ${nodeId}):`, e.message);
		return jsonResponse({ error: 'Database Error', message: e.message }, 500);
	}
}

/**
 * PUT /api/docs/node/:id - 更新（保存）一个文档节点的内容
 */
async function handleDocsNodeUpdate(request, nodeId, env) {
	try {
		const { content } = await request.json();
		const now = Date.now();
		const stmt = env.DB.prepare("UPDATE nodes SET content = ?, updated_at = ? WHERE id = ?");
		await stmt.bind(content, now, nodeId).run();
		return jsonResponse({ success: true, id: nodeId });
	} catch (e) {
		console.error(`Docs Update Node Error (id: ${nodeId}):`, e.message);
		return jsonResponse({ error: 'Database Error', message: e.message }, 500);
	}
}

/**
 * POST /api/docs/node - 创建一个新的文档节点（文件或目录）
 */
async function handleDocsNodeCreate(request, env) {
	try {
		const { type, title, parent_id = null } = await request.json();
		if (!type || !title || !['file', 'folder'].includes(type)) {
			return jsonResponse({ error: 'Invalid input' }, 400);
		}

		const newNode = {
			id: crypto.randomUUID(),
			type,
			title,
			content: type === 'file' ? `# ${title}` : null,
			parent_id,
			created_at: Date.now(),
			updated_at: Date.now(),
		};

		const stmt = env.DB.prepare(
			"INSERT INTO nodes (id, type, title, content, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
		);
		await stmt.bind(...Object.values(newNode)).run();

		return jsonResponse(newNode, 201);
	} catch (e) {
		console.error("Docs Create Node Error:", e.message);
		return jsonResponse({ error: 'Database Error', message: e.message }, 500);
	}
}

/**
 * Recursively finds all descendant node IDs for a given parent ID.
 * @param {D1Database} db - The D1 database instance.
 * @param {string} parentId - The ID of the node to start from.
 * @returns {Promise<string[]>} A flat array of all descendant IDs.
 */
async function getAllDescendantIds(db, parentId) {
	let allIds = [];
	let queue = [parentId];
	while (queue.length > 0) {
		const currentId = queue.shift();
		const { results: children } = await db.prepare("SELECT id FROM nodes WHERE parent_id = ?").bind(currentId).all();
		if (children && children.length > 0) {
			const childIds = children.map(c => c.id);
			allIds.push(...childIds);
			queue.push(...childIds);
		}
	}
	return allIds;
}

// DELETE and REMOVE the entire `getAllDescendantIds` function.

/**
 * DELETE /api/docs/node/:id - 删除一个节点。
 * 数据库的 "ON DELETE CASCADE" 约束会自动处理所有子节点的删除。
 */
async function handleDocsNodeDelete(request, nodeId, env) {
	const db = env.DB;
	try {
		const nodeToDelete = await db.prepare("SELECT id FROM nodes WHERE id = ?").bind(nodeId).first();
		if (!nodeToDelete) {
			return jsonResponse({ error: "节点未找到。" }, 404);
		}

		// 只需要删除这一个节点，数据库会自动删除所有子孙节点。
		await db.prepare("DELETE FROM nodes WHERE id = ?").bind(nodeId).run();

		// 我们不再需要返回所有被删除的子节点ID，因为前端逻辑也不依赖它。
		return jsonResponse({ success: true, deletedIds: [nodeId] });

	} catch (e) {
		console.error(`Docs Delete Node Error (id: ${nodeId}):`, e.message, e.cause);
		return jsonResponse({ error: 'Database Error', message: e.message }, 500);
	}
}

async function handleDocsNodeMove(request, nodeId, env) {
	const db = env.DB;
	try {
		const { new_parent_id } = await request.json();
		const nodeToMove = await db.prepare("SELECT * FROM nodes WHERE id = ?").bind(nodeId).first();

		// --- Validation ---
		if (!nodeToMove) {
			return jsonResponse({ error: "The node you are trying to move does not exist." }, 404);
		}
		if (nodeId === new_parent_id) {
			return jsonResponse({ error: "Cannot move a node into itself." }, 400);
		}
		if (nodeToMove.parent_id === new_parent_id) {
			return jsonResponse({ success: true, message: "Node is already in the target location." }); // No-op
		}

		if (new_parent_id !== null) {
			const parentNode = await db.prepare("SELECT type FROM nodes WHERE id = ?").bind(new_parent_id).first();
			if (!parentNode) {
				return jsonResponse({ error: "Target destination does not exist." }, 404);
			}
			if (parentNode.type !== 'folder') {
				return jsonResponse({ error: "Target destination must be a folder." }, 400);
			}
		}

		let currentParentId = new_parent_id;
		while (currentParentId !== null) {
			if (currentParentId === nodeId) {
				return jsonResponse({ error: "Cannot move a folder into one of its own descendants." }, 400);
			}
			// CRITICAL FIX: Check if the parent exists before trying to read its properties
			const parent = await db.prepare("SELECT parent_id FROM nodes WHERE id = ?").bind(currentParentId).first();
			if (!parent) {
				// This prevents a crash if the chain is broken
				break;
			}
			currentParentId = parent.parent_id;
		}

		// --- Update the node ---
		const stmt = db.prepare("UPDATE nodes SET parent_id = ?, updated_at = ? WHERE id = ?");
		await stmt.bind(new_parent_id, Date.now(), nodeId).run();

		return jsonResponse({ success: true });
	} catch (e) {
		console.error(`Docs Move Node Error (id: ${nodeId}):`, e.message, e.cause);
		return jsonResponse({ error: 'Database Error', message: e.message }, 500);
	}
}

/**
 * PATCH /api/docs/node/:id/rename - Renames a node.
 */
async function handleDocsNodeRename(request, nodeId, env) {
	const db = env.DB;
	try {
		const { new_title } = await request.json();

		// 验证 new_title 是否存在且不为空
		if (!new_title || typeof new_title !== 'string' || new_title.trim() === '') {
			return jsonResponse({ error: "A valid new title is required." }, 400);
		}

		const stmt = db.prepare("UPDATE nodes SET title = ?, updated_at = ? WHERE id = ?");
		await stmt.bind(new_title.trim(), Date.now(), nodeId).run();

		return jsonResponse({ success: true, new_title: new_title.trim() });
	} catch (e) {
		console.error(`Docs Rename Node Error (id: ${nodeId}):`, e.message, e.cause);
		return jsonResponse({ error: 'Database Error', message: e.message }, 500);
	}
}

/**
 * 为文件生成一个唯一的、可公开访问的链接。
 * POST /api/notes/:noteId/files/:fileId/share
 */
async function handleShareFileRequest(noteId, fileId, request, env) {
	const db = env.DB;
	const id = parseInt(noteId);
	if (isNaN(id)) {
		return new Response('Invalid Note ID', { status: 400 });
	}

	try {
		const note = await db.prepare("SELECT files FROM notes WHERE id = ?").bind(id).first();
		if (!note) {
			return jsonResponse({ error: 'Note not found' }, 404);
		}

		let files = [];
		try {
			if (typeof note.files === 'string') {
				files = JSON.parse(note.files);
			}
		} catch(e) { /* ignore */ }

		const fileIndex = files.findIndex(f => f.id === fileId);
		if (fileIndex === -1) {
			return jsonResponse({ error: 'File not found in this note' }, 404);
		}

		const file = files[fileIndex];
		let publicId = file.public_id;

		if (!publicId) {
			publicId = crypto.randomUUID();
			// 1. 在 KV 中存储映射关系，用于快速、免认证的查找
			await env.NOTES_KV.put(`public_file:${publicId}`, JSON.stringify({
				noteId: id,
				fileId: file.id,
				fileName: file.name,
				contentType: file.type
			}));

			// 2. 将 public_id 持久化到 D1 数据库中
			files[fileIndex].public_id = publicId;
			await db.prepare("UPDATE notes SET files = ? WHERE id = ?").bind(JSON.stringify(files), id).run();
		}

		const { protocol, host } = new URL(request.url);
		const publicUrl = `${protocol}//${host}/api/public/file/${publicId}`;

		return jsonResponse({ url: publicUrl });
	} catch (e) {
		console.error(`Share File Error (noteId: ${noteId}, fileId: ${fileId}):`, e.message);
		return jsonResponse({ error: 'Database error while generating link', message: e.message }, 500);
	}
}

/**
 * 处理对公开文件链接的访问请求，无需身份验证。
 * GET /api/public/file/:publicId
 */
async function handlePublicFileRequest(publicId, request, env) {
	const kvData = await env.NOTES_KV.get(`public_file:${publicId}`, 'json');
	if (!kvData) {
		return new Response('Public link not found or has expired.', { status: 404 });
	}
	const { noteId, fileId, fileName, contentType } = kvData;

	const object = await env.NOTES_R2_BUCKET.get(`${noteId}/${fileId}`);
	if (object === null) {
		return new Response('File not found in storage', { status: 404 });
	}

	const headers = new Headers();
	object.writeHttpMetadata(headers);
	headers.set('etag', object.httpEtag);
	headers.set('Cache-Control', 'public, max-age=86400, immutable'); // 缓存24小时

	// 始终以内联方式提供（raw content），而不是作为附件下载
	headers.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`);
	// 确保文本文件以 text/plain 形式提供，防止浏览器执行代码
	const textLikeExtensions = ['txt', 'md', 'log', 'json', 'js', 'css', 'html', 'xml', 'yaml', 'yml', 'py', 'sh', 'rb', 'go', 'java', 'c', 'cpp'];
	if ((contentType || '').startsWith('text/') || textLikeExtensions.includes((fileName || '').split('.').pop().toLowerCase())) {
		headers.set('Content-Type', 'text/plain; charset=utf-8');
	} else {
		headers.set('Content-Type', contentType || 'application/octet-stream');
	}

	return new Response(object.body, { headers });
}

/**
 * 统一的 JSON 响应函数
 */
function jsonResponse(data, status = 200, headers = new Headers()) {
	headers.set('Content-Type', 'application/json');
	return new Response(JSON.stringify(data, null, 2), { status, headers });
}
