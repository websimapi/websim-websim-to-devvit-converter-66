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
    realtime
} from '@devvit/web/server';
import { addPaymentHandler } from '@devvit/payments';

// Enable Realtime & Reddit API
Devvit.configure({
    redditAPI: true,
    realtime: true,
    http: true
});

// --- Payments Handler ---
// Handles tip_X_gold products
addPaymentHandler({
    fulfillOrder: async (order, ctx) => {
        if (order.status === 'PAID') {
            try {
                const product = order.products && order.products[0];
                const sku = product ? product.sku : '';
                
                // SKU format: tip_25_gold
                const match = sku.match(/tip_(\d+)_gold/);
                const amount = match ? parseInt(match[1]) : 0;
                
                if (amount > 0 && ctx.userId && ctx.postId) {
                    const tipKey = \`tips:\${ctx.postId}:\${ctx.userId}\`;
                    await ctx.redis.incrBy(tipKey, amount);
                    
                    // Automated Thank You Comment
                    try {
                        const comment = await ctx.reddit.submitComment({
                            id: ctx.postId,
                            text: \`**Tipped \${amount} Gold!** 🟡\\n\\n*(Automated via Devvit Payments)*\`
                        });
                        
                        const metaKey = \`comment_metadata:\${comment.id}\`;
                        await ctx.redis.hSet(metaKey, {
                            type: 'tip_comment',
                            credits_spent: String(amount)
                        });
                    } catch(err) {
                        console.warn('Failed to post tip comment:', err);
                    }
                }
            } catch (e) {
                console.error("Payment Fulfillment Error:", e);
            }
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
                user = { 
                    id: context.userId, 
                    username: context.username || 'RedditUser',
                    avatar_url: user.avatar_url // Default
                };
            }
            
            // Always try to fetch rich profile for snoovatar (Server Source of Truth)
            const currUser = await reddit.getCurrentUser();
            if (currUser) {
                const snoovatarUrl = await currUser.getSnoovatarUrl();
                user = {
                    id: currUser.id,
                    username: currUser.username,
                    // Use Snoovatar if available, else fallback to standard Reddit static default
                    avatar_url: snoovatarUrl ?? 'https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png'
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

        // Get all historical orders for this user
        // Note: In Devvit Web, context.payments provides getOrders
        const orders = await context.payments.getOrders({
            userId: userId
        });

        const successfulSkus = orders
            .filter(o => o.status === 'PAID')
            .flatMap(o => o.products.map(p => p.sku));

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
router.post('/internal/payments/fulfill', async (req, res) => {
    try {
        // The payment data is passed in the request body.
        // It's often the order object itself, but we'll check both patterns for robustness.
        const order = req.body.order || req.body;
        
        if (!order || typeof order !== 'object') {
            return res.status(400).json({ success: false, reason: "Invalid or missing order data" });
        }

        console.log(\`[Server] Fulfillment Received: ID=\${order.id} Status=\${order.status}\`);

        if (order.status === 'PAID') {
            const product = order.products && order.products[0];
            const sku = product ? product.sku : '';
            
            // SKU format: tip_25_gold
            const match = sku.match(/tip_(\d+)_gold/);
            const amount = match ? parseInt(match[1]) : 0;
            
            // Extract IDs from order if context is not yet hydrated (failsafe)
            const userId = context.userId || order.userId;
            const postId = context.postId || order.postId;

            if (amount > 0 && userId && postId) {
                const tipKey = \`tips:\${postId}:\${userId}\`;
                await redis.incrBy(tipKey, amount);
                
                // Automated Thank You Comment
                try {
                    const comment = await reddit.submitComment({
                        id: postId,
                        text: \`**Tipped \${amount} Gold!** 🟡\\n\\n*(Automated via Devvit Payments)*\`
                    });
                    
                    const metaKey = \`comment_metadata:\${comment.id}\`;
                    await redis.hSet(metaKey, {
                        type: 'tip_comment',
                        credits_spent: String(amount)
                    });
                } catch(err) {
                    console.warn('Failed to post tip comment:', err);
                }
            }
            return res.json({ success: true });
        }

        res.json({ success: false, reason: \`Unexpected order status: \${order.status}\` });
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

        // Get comments from Reddit
        let comments = [];
        try {
            // reddit.getComments returns a Promise<Listing<Comment>>
            const listing = await reddit.getComments({
                postId: postId,
                limit: onlyTips ? 100 : 50
            });
            // Convert listing to array safely if it's iterable
            comments = listing || [];
            if (listing && typeof listing.all === 'function') {
                 // Some versions of Devvit client expose .all()
                 comments = await listing.all();
            }
        } catch (e) {
            console.warn('Reddit API getComments failed:', e);
            comments = [];
        }

        // Transform to WebSim format
        let data = await Promise.all(comments.map(async (c) => {
            // Check for tip metadata
            const metaKey = \`comment_metadata:\${c.id}\`;
            const meta = await redis.hGetAll(metaKey);
            const isTip = meta && meta.type === 'tip_comment';
            
            // Filter early if we only want tips
            if (onlyTips && !isTip) return null;

            return {
                comment: {
                    id: c.id,
                    project_id: 'local',
                    raw_content: c.body,
                    content: { type: 'doc', content: [] }, // simplified structure
                    author: {
                        id: c.authorId,
                        username: c.authorName,
                        avatar_url: '/_websim_avatar_/' + c.authorName
                    },
                    reply_count: 0, 
                    created_at: c.createdAt.toISOString(),
                    parent_comment_id: c.parentId.startsWith('t1_') ? c.parentId : null,
                    card_data: isTip ? {
                        type: 'tip_comment',
                        credits_spent: parseInt(meta.credits_spent || '0')
                    } : null
                }
            };
        }));

        // Remove filtered items
        data = data.filter(item => item !== null);

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

