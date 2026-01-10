export const getMainTs = (title) => {
    const safeTitle = title.replace(/'/g, "\\'");
    return `
import express from 'express';
import { Devvit } from '@devvit/public-api';
import { 
    createServer, 
    context, 
    getServerPort, 
    redis, 
    reddit,
    realtime,
    payments
} from '@devvit/web/server';
import { addPaymentHandler } from '@devvit/payments';

// Enable Realtime & Reddit API
Devvit.configure({
    redditAPI: true,
    realtime: true,
    http: true
});

// --- Payments Handler ---
// This handles native Reddit payments (e.g. via upvote gold)
addPaymentHandler({
    fulfillOrder: async (order, ctx) => {
        try {
            await handleOrderFulfillment(order, ctx);
        } catch (e) {
            console.error("Payment Fulfillment Error (Native):", e);
        }
    }
});

const app = express();

// Body parsers
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.text({ limit: '10mb' }));

const router = express.Router();

// --- Database Helpers ---
const DB_REGISTRY_KEY = 'sys:registry';

async function fetchAllData() {
    try {
        const collections = await redis.zRange(DB_REGISTRY_KEY, 0, -1);
        const dbData = {};

        await Promise.all(collections.map(async (item) => {
            const colName = typeof item === 'string' ? item : item.member;
            const raw = await redis.hGetAll(colName);
            const parsed = {};
            for (const [k, v] of Object.entries(raw)) {
                try { parsed[k] = JSON.parse(v); } catch(e) { parsed[k] = v; }
            }
            dbData[colName] = parsed;
        }));

        let user = { 
            id: 'anon', 
            username: 'Guest', 
            avatar_url: 'https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png' 
        };
        
        try {
            // Try to get current user from context or Reddit API
            if (context.userId) {
                const tipKey = `tips:${context.postId}:${context.userId}`;
                const totalTipped = await redis.get(tipKey);

                user = { 
                    id: context.userId, 
                    username: context.username || 'RedditUser',
                    avatar_url: user.avatar_url, // Default
                    total_tipped: parseInt(totalTipped || '0')
                };
            }
            
            // Always try to fetch rich profile for snoovatar (Server Source of Truth)
            const currUser = await reddit.getCurrentUser();
            if (currUser) {
                const snoovatarUrl = await currUser.getSnoovatarUrl();
                const tipKey = `tips:${context.postId}:${currUser.id}`;
                const totalTipped = await redis.get(tipKey);

                user = {
                    id: currUser.id,
                    username: currUser.username,
                    // Use Snoovatar if available, else fallback to standard Reddit static default
                    avatar_url: snoovatarUrl ?? 'https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png',
                    total_tipped: parseInt(totalTipped || '0')
                };
            }
        } catch(e) {
            console.warn('User fetch failed', e); 
        }

        return { dbData, user };
    } catch(e) {
        console.error('Hydration Error:', e);
        return { dbData: {}, user: null };
    }
}

// --- API Routes (Client -> Server) ---
// Note: All client-callable endpoints must start with /api/

router.get('/api/init', async (_req, res) => {
    const data = await fetchAllData();
    res.json(data);
});

router.get('/api/payments/history', async (req, res) => {
    try {
        const userId = context.userId;
        if (!userId) return res.json({ purchases: [] });

        // Get all historical orders for this user using the server payments SDK
        // response can be { orders: [] } or just [] depending on SDK version
        const response = await payments.getOrders({
            userId: userId
        }).catch(() => ({ orders: [] }));

        const ordersArray = Array.isArray(response) ? response : (response?.orders || []);

        const successfulSkus = ordersArray
            .filter(o => o && (o.status === 'PAID' || o.status === 1)) // 1 is often PAID enum
            .flatMap(o => (o.products || []).map(p => p.sku));

        res.json({ purchases: successfulSkus });
    } catch (e) {
        console.error('History Fetch Error:', e);
        res.json({ purchases: [] });
    }
});

// Polyfill Endpoint: Get Project/Context Info
router.get('/api/project', async (_req, res) => {
    try {
        const { postId, subredditName, userId } = context;
        // Map Devvit Context to WebSim Project Structure
        res.json({
            id: postId || 'local-dev',
            title: subredditName ? \`r/\${subredditName}\` : 'Devvit Project',
            current_version: '1',
            owner: { 
                id: subredditName || 'community',
                username: subredditName || 'community' 
            },
            context: { postId, subredditName, userId }
        });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/api/user', async (_req, res) => {
    const { user } = await fetchAllData();
    res.json(user);
});

router.get('/api/identity', async (_req, res) => {
    const { user } = await fetchAllData();
    res.json(user);
});

router.post('/api/save', async (req, res) => {
    try {
        const { collection, key, value } = req.body;
        if (!collection || !key) return res.status(400).json({ error: 'Missing collection or key' });

        // Ensure value is safe to stringify (undefined -> null)
        const safeValue = value === undefined ? null : value;

        await redis.hSet(collection, { [key]: JSON.stringify(safeValue) });
        await redis.zAdd(DB_REGISTRY_KEY, { member: collection, score: Date.now() });
        res.json({ success: true, collection, key });
    } catch(e) {
        console.error('DB Save Error:', e);
        res.status(500).json({ error: e.message });
    }
});

router.post('/api/load', async (req, res) => {
    try {
        const { collection, key } = req.body;
        const value = await redis.hGet(collection, key);
        res.json({ collection, key, value: value ? JSON.parse(value) : null });
    } catch(e) {
        console.error('DB Get Error:', e);
        res.status(500).json({ error: e.message });
    }
});

router.post('/api/delete', async (req, res) => {
    try {
        const { collection, key } = req.body;
        if (!collection || !key) return res.status(400).json({ error: 'Missing collection or key' });

        await redis.hDel(collection, [key]);
        res.json({ success: true, collection, key });
    } catch(e) {
        console.error('DB Delete Error:', e);
        res.status(500).json({ error: e.message });
    }
});

// --- Realtime Relay (Client -> Server -> Clients) ---
// --- Payments Endpoints (Fulfillment) ---
async function handleOrderFulfillment(order, ctx) {
    if (!order || (order.status !== 'PAID' && order.status !== 1)) return;

    const product = order.products && order.products[0];
    const sku = product ? product.sku : '';
    const userId = ctx.userId || order.userId;
    const postId = ctx.postId || order.postId;

    // SKU format: tip_25_gold
    const match = sku.match(/tip_(\\d+)_gold/);
    const amount = match ? parseInt(match[1]) : 0;

    if (amount > 0 && userId && postId) {
        console.log(\`[Server] Processing Tip: \${amount} Gold from \${userId} on \${postId}\`);
        
        // 1. Update Per-User Running Total (Redis source of truth)
        const tipKey = \`tips:\${postId}:\${userId}\`;
        await redis.incrBy(tipKey, amount);

        // 2. Automated Thank You Comment
        try {
            const comment = await reddit.submitComment({
                id: postId,
                text: \`**Tipped \${amount} Gold!** 🟡\\n\\n*(Verified Transaction)*\`
            });
            
            // 3. Register the comment as a tip in Redis registry
            const registryKey = \`tips_registry:\${postId}\`;
            const meta = JSON.stringify({
                comment_id: comment.id,
                user_id: userId,
                amount: amount,
                timestamp: Date.now()
            });
            await redis.zAdd(registryKey, { member: meta, score: Date.now() });

            const metaKey = \`comment_metadata:\${comment.id}\`;
            await redis.hSet(metaKey, {
                type: 'tip_comment',
                credits_spent: String(amount)
            });
        } catch(err) {
            console.warn('Failed to post tip comment:', err);
        }
    }
}

router.post('/internal/payments/fulfill', async (req, res) => {
    try {
        const order = req.body.order || req.body;
        if (!order || typeof order !== 'object') {
            return res.status(400).json({ success: false, reason: "Invalid or missing order data" });
        }

        console.log(\`[Server] Fulfillment Received: ID=\${order?.id || 'unknown'} Status=\${order?.status || 'unknown'}\`);
        await handleOrderFulfillment(order, context);
        res.json({ success: true });
    } catch (e) {
        console.error('Payment Fulfillment Error:', e);
        res.status(500).json({ success: false, reason: e.message });
    }
});

router.post('/internal/payments/refund', async (req, res) => {
    res.json({ success: true });
});

router.post('/api/realtime/message', async (req, res) => {
    try {
        const msg = req.body;
        // console.log('[Server] Relaying Realtime Message:', JSON.stringify(msg).substring(0, 200));
        
        // Broadcast to 'global_room' which clients subscribe to via connectRealtime
        await realtime.send('global_room', msg);
        res.json({ success: true });
    } catch(e) {
        console.error('[Server] Realtime Relay Error:', e);
        res.status(500).json({ error: e.message });
    }
});

// --- Comment API (WebSim Polyfill) ---
router.get('/api/comments', async (req, res) => {
    try {
        const postId = context.postId;
        if (!postId) return res.json({ comments: { data: [], meta: {} } });

        const onlyTips = req.query.only_tips === 'true';

        // 1. Get Official Tips from Registry (Redis Source of Truth)
        const registryKey = \`tips_registry:\${postId}\`;
        const registryRaw = await redis.zRange(registryKey, 0, -1);
        const registeredTips = registryRaw.map(r => {
            try { return JSON.parse(typeof r === 'string' ? r : r.member); } catch(e) { return null; }
        }).filter(Boolean);

        // 2. Get comments from Reddit API
        let comments = [];
        try {
            const listing = await reddit.getComments({
                postId: postId,
                limit: onlyTips ? 100 : 50
            });
            comments = Array.isArray(listing) ? listing : (listing?.all ? await listing.all() : []);
        } catch (e) {
            console.warn('Reddit API getComments failed:', e);
        }

        // 3. Transform & Hot-Swap Data
        let data = await Promise.all(comments.map(async (c) => {
            const metaKey = \`comment_metadata:\${c.id}\`;
            const meta = await redis.hGetAll(metaKey);
            
            // Check if this comment is a known tip
            const isTip = meta && meta.type === 'tip_comment';
            
            if (onlyTips && !isTip) return null;

            return {
                comment: {
                    id: c.id,
                    project_id: 'local',
                    raw_content: c.body,
                    content: { type: 'doc', content: [] },
                    author: {
                        id: c.authorId,
                        username: c.authorName,
                        avatar_url: '/_websim_avatar_/' + c.authorName
                    },
                    reply_count: 0, 
                    created_at: c.createdAt ? c.createdAt.toISOString() : new Date().toISOString(),
                    parent_comment_id: c.parentId?.startsWith('t1_') ? c.parentId : null,
                    card_data: isTip ? {
                        type: 'tip_comment',
                        credits_spent: parseInt(meta.credits_spent || '0')
                    } : null
                }
            };
        }));

        // 4. Inject Virtual Tips (Transactions that might be missing from the current page of comments)
        if (onlyTips) {
            const existingIds = new Set(data.filter(Boolean).map(item => item.comment.id));
            registeredTips.forEach(tip => {
                if (!existingIds.has(tip.comment_id)) {
                    data.push({
                        comment: {
                            id: tip.comment_id,
                            project_id: 'local',
                            raw_content: \`**Tipped \${tip.amount} Gold!** 🟡\`,
                            author: { id: tip.user_id, username: 'RedditUser', avatar_url: '/_websim_avatar_/unknown' },
                            created_at: new Date(tip.timestamp).toISOString(),
                            card_data: { type: 'tip_comment', credits_spent: tip.amount }
                        }
                    });
                }
            });
        }

        // Filter nulls and sort by date descending
        data = data.filter(item => item !== null).sort((a,b) => 
            new Date(b.comment.created_at).getTime() - new Date(a.comment.created_at).getTime()
        );

        res.json({
            comments: {
                data: data,
                meta: { has_next_page: false, end_cursor: null }
            }
        });

    } catch (e) {
        console.error('Fetch Comments Endpoint Error:', e);
        // Return valid empty response on error to prevent client "Failed to fetch" crashes
        res.json({ comments: { data: [], meta: {} } });
    }
});

router.post('/api/comments', async (req, res) => {
    try {
        const { content, parentId } = req.body;
        const postId = context.postId;
        
        if (!postId) return res.status(400).json({ error: 'No Post Context' });
        
        const text = typeof content === 'string' ? content : '';
        if (!text.trim()) {
            return res.status(400).json({ error: 'Comment content cannot be empty' });
        }

        // Use User Actions to post as the authenticated user
        // We use 'id' which covers both top-level posts and comments
        const targetId = parentId || postId;

        console.log(\`[Server] submitComment: id=\${targetId} text_len=\${text.length}\`);

        // [Fixed] Post as user using runAs: 'USER'
        // Requires "permissions": { "reddit": { "asUser": ["SUBMIT_COMMENT"] } } in devvit.json
        const result = await reddit.submitComment({
            id: targetId,
            text: text,
            runAs: 'USER'
        });

        res.json({ success: true, id: result.id });
    } catch (e) {
        console.error('Post Comment Error:', e);
        res.status(500).json({ error: e.message });
    }
});

// --- Avatar Lookup Route (Client Injection) ---
router.get('/api/lookup/avatar/:username', async (req, res) => {
    const { username } = req.params;
    const defaultAvatar = 'https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png';
    
    if (username === 'guest' || username === 'null' || !username) {
        return res.json({ url: defaultAvatar });
    }

    try {
        const user = await reddit.getUserByUsername(username);
        let url = null;
        if (user) {
            url = await user.getSnoovatarUrl();
        }
        res.json({ url: url || defaultAvatar });
    } catch (e) {
        console.warn('Avatar lookup failed for', username, e.message);
        res.json({ url: defaultAvatar });
    }
});

// --- WebSim Search Proxies ---
router.get('/api/v1/search/assets', async (req, res) => {
    try {
        const query = new URLSearchParams(req.query).toString();
        const response = await fetch(\`https://websim.ai/api/v1/search/assets?\${query}\`);
        if (!response.ok) return res.status(response.status).json({ error: 'Upstream Error' });
        const data = await response.json();
        res.json(data);
    } catch (e) {
        console.error('Search Proxy Error:', e);
        res.status(500).json({ error: e.message });
    }
});

router.get('/api/v1/search/assets/relevant', async (req, res) => {
    try {
        const query = new URLSearchParams(req.query).toString();
        const response = await fetch(\`https://websim.ai/api/v1/search/assets/relevant?\${query}\`);
        if (!response.ok) return res.status(response.status).json({ error: 'Upstream Error' });
        const data = await response.json();
        res.json(data);
    } catch (e) {
        console.error('Search Proxy Error:', e);
        res.status(500).json({ error: e.message });
    }
});

// --- Avatar Proxy Route (Legacy/Fallback) ---
router.get('/api/proxy/avatar/:username', async (req, res) => {
    const { username } = req.params;
    try {
        // Attempt to get the latest Snoovatar from Reddit
        const user = await reddit.getUserByUsername(username);
        let url = null;
        if (user) {
            url = await user.getSnoovatarUrl();
        }
        res.redirect(url || 'https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png');
    } catch (e) {
        // Fallback silently if user not found or API error
        res.redirect('https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png');
    }
});

// --- JSON "File" Upload Routes (Redis-backed) ---
router.post('/api/json/:key', async (req, res) => {
    try {
        const { key } = req.params;
        const data = req.body;
        // Persist JSON to Redis
        await redis.set('json:' + key, JSON.stringify(data));
        res.json({ ok: true, url: '/api/json/' + key });
    } catch(e) {
        console.error('JSON Upload Error:', e);
        res.status(500).json({ error: e.message });
    }
});

router.get('/api/json/:key', async (req, res) => {
    try {
        const { key } = req.params;
        const data = await redis.get('json:' + key);
        if (!data) return res.status(404).json({ error: 'Not found' });
        
        // Return as proper JSON
        res.header('Content-Type', 'application/json');
        res.send(data);
    } catch(e) {
        console.error('JSON Load Error:', e);
        res.status(500).json({ error: e.message });
    }
});

// --- Internal Routes (Menu/Triggers) ---
// Note: All internal endpoints must start with /internal/

router.post('/internal/onInstall', async (req, res) => {
    console.log('App installed!');
    res.json({ success: true });
});

router.post('/internal/createPost', async (req, res) => {
    console.log('Creating game post...');
    
    try {
        // Use the global context object from @devvit/web/server, fallback to headers if needed
        const subredditName = context?.subredditName || req.headers['x-devvit-subreddit-name'];
        console.log('Context Subreddit:', subredditName);

        if (!subredditName) {
            return res.status(400).json({ error: 'Subreddit name is required (context/header missing)' });
        }

        const post = await reddit.submitCustomPost({
            title: '${safeTitle}',
            subredditName: subredditName,
            entry: 'default', // matches devvit.json entrypoint
            userGeneratedContent: {
                text: 'Play this game built with WebSim!'
            }
        });

        res.json({
            showToast: { text: 'Game post created!' },
            navigateTo: post
        });
    } catch (e) {
        console.error('Failed to create post:', e);
        res.status(500).json({ error: e.message });
    }
});

app.use(router);

const port = getServerPort();
const server = createServer(app);

server.on('error', (err) => console.error(\`server error; \${err.stack}\`));
server.listen(port, () => console.log(\`Server listening on \${port}\`));
`;
};

