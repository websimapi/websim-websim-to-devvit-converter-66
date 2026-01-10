export const websimStubsJs = `
// [WebSim] API Stubs - Global Script
(function() {
    // Shared state via window._currentUser (managed by socket.js/DevvitBridge)
    const getSharedUser = () => window._currentUser;

    // --- 1. Monkeypatch Fetch for Comments API ---
    const originalFetch = window.fetch;
    window.fetch = async function(input, init) {
        let url = input;
        if (typeof input === 'string') {
            // Intercept WebSim Comment API calls
            // Matches: /api/v1/projects/{UUID}/comments... (Capture query params)
            const commentMatch = input.match(/\\/api\\/v1\\/projects\\/[^/]+\\/comments(.*)/);
            if (commentMatch) {
                const query = commentMatch[1] || '';
                // console.log("[Polyfill] Intercepting Comment Fetch:", input, "->", '/api/comments' + query);
                return originalFetch('/api/comments' + query, init);
            }
        }
        return originalFetch(input, init);
    };

    if (!window.websim) {
        window.websim = {
            getCurrentUser: async () => {
                // Wait for handshake (up to 3s)
                let tries = 0;
                while(!getSharedUser() && tries < 30) {
                    await new Promise(r => setTimeout(r, 100));
                    tries++;
                }
                
                const u = getSharedUser() || {
                    id: 'guest', username: 'Guest', avatar_url: 'https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png',
                    total_tipped: 0
                };
                
                // Polyfill camelCase and common property names
                if (u.avatar_url && !u.avatarUrl) u.avatarUrl = u.avatar_url;
                if (u.total_tipped !== undefined) u.credits = u.total_tipped;
                
                return u;
            },
            getProject: async () => {
                try {
                    const res = await fetch('/api/project');
                    if (res.ok) return await res.json();
                } catch(e) { console.warn("[Polyfill] getProject failed:", e); }
                return { id: 'local', title: 'Reddit Game', current_version: '1', owner: { username: 'unknown' } };
            },
            getCurrentProject: async () => {
                return window.websim.getProject();
            },
            getCreator: async () => {
                try {
                    const res = await fetch('/api/project');
                    if (res.ok) {
                        const data = await res.json();
                        return data.owner;
                    }
                } catch(e) { console.warn("[Polyfill] getCreator failed:", e); }
                return { id: 'owner', username: 'GameOwner' };
            },
            
            // --- Commenting & Tipping Polyfill ---
            postComment: async (data) => {
                // Data: { content: string, parent_comment_id?: string, credits?: number }
                console.log("[Polyfill] postComment:", data);

                return new Promise((resolve) => {
                    // UI Injection for Comment/Tip Modal
                    // We render a custom HTML modal to mimic the WebSim "staging" step
                    const modal = document.createElement('div');
                    modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.8);z-index:9999;display:flex;align-items:center;justify-content:center;font-family:sans-serif;color:white;';
                    
                    const isTip = data.credits && data.credits > 0;
                    const prefilled = data.content || '';
                    
                    let innerHtml = '';
                    
                    if (isTip) {
                        innerHtml = \`
                            <div style="background:#1e293b;padding:24px;border-radius:12px;width:90%;max-width:400px;text-align:center;border:1px solid #334155;box-shadow: 0 20px 25px -5px rgba(0,0,0,0.5);">
                                <h3 style="margin:0 0 16px 0;">💛 Support the Creator</h3>
                                <p style="color:#94a3b8;margin-bottom:24px;line-height:1.5;">
                                    This app is requesting a <strong>\${data.credits} Gold</strong> tip.
                                </p>
                                <div id="ws-tip-status" style="margin-bottom:20px; font-size:0.9rem; color:#f8fafc; min-height:1.2em;"></div>
                                <div style="display:flex;gap:12px;">
                                    <button id="ws-modal-cancel" style="background:transparent;color:#94a3b8;border:1px solid #334155;padding:10px 16px;border-radius:6px;cursor:pointer;flex:1;">Cancel</button>
                                    <button id="ws-modal-tip" style="background:#FF4500;color:white;border:none;padding:10px 24px;border-radius:6px;font-weight:bold;cursor:pointer;flex:2;">Send Tip</button>
                                </div>
                            </div>
                        \`;
                    } else {
                        innerHtml = \`
                            <div style="background:#1e293b;padding:24px;border-radius:12px;width:90%;max-width:500px;display:flex;flex-direction:column;gap:16px;border:1px solid #334155;">
                                <h3 style="margin:0;">💬 Post a Comment</h3>
                                <textarea id="ws-comment-input" style="width:100%;height:100px;background:#0f172a;border:1px solid #334155;border-radius:8px;color:white;padding:12px;font-family:inherit;resize:none;box-sizing:border-box;">\${prefilled}</textarea>
                                <div style="display:flex;gap:10px;justify-content:flex-end;">
                                    <button id="ws-modal-cancel" style="background:transparent;color:#94a3b8;border:none;padding:10px 16px;cursor:pointer;font-weight:600;">Cancel</button>
                                    <button id="ws-modal-post" style="background:#FF4500;color:white;border:none;padding:10px 24px;border-radius:6px;font-weight:bold;cursor:pointer;">Post Comment</button>
                                </div>
                            </div>
                        \`;
                    }
                    
                    modal.innerHTML = innerHtml;
                    document.body.appendChild(modal);
                    
                    const close = () => { document.body.removeChild(modal); };

                    if (isTip) {
                        modal.querySelector('#ws-modal-cancel').onclick = () => {
                            close();
                            resolve({ error: 'User cancelled' });
                        };
                        modal.querySelector('#ws-modal-tip').onclick = async () => {
                            const btn = modal.querySelector('#ws-modal-tip');
                            const status = modal.querySelector('#ws-tip-status');
                            btn.disabled = true;
                            btn.textContent = 'Processing...';
                            
                            try {
                                if (!window.purchase) throw new Error("Purchase API not available");
                                
                                // Reddit Gold Tiers: 5, 25, 50, 100, 150, 250, 500, 1000, 2500
                                const validTiers = [5, 25, 50, 100, 150, 250, 500, 1000, 2500];
                                const requested = Number(data.credits);
                                // Find closest valid tier (round up preferred for tips)
                                const tier = validTiers.find(t => t >= requested) || validTiers[validTiers.length - 1];
                                
                                if (tier !== requested) {
                                     console.log(\`[Polyfill] Adjusting tip amount from \${requested} to nearest Reddit tier: \${tier}\`);
                                }

                                const sku = \`tip_\${tier}_gold\`;
                                const result = await window.purchase(sku);
                                
                                if (result.status === window.OrderResultStatus.STATUS_SUCCESS) {
                                    status.style.color = '#10b981';
                                    status.textContent = 'Success! Thank you for your support.';
                                    
                                    // Dispatch local event so game can react immediately
                                    window.dispatchEvent(new CustomEvent('websim_purchase_success', { 
                                        detail: { sku, credits: tier } 
                                    }));

                                    // Note: Content is now handled by fulfillment intent hotswap
                                    
                                    setTimeout(() => {
                                        close();
                                        resolve({});
                                    }, 1500);
                                } else {
                                    throw new Error(result.errorMessage || 'Purchase failed or was cancelled');
                                }
                            } catch(e) {
                                console.error("Tipping Failed:", e);
                                status.style.color = '#ef4444';
                                status.textContent = e.message;
                                btn.disabled = false;
                                btn.textContent = 'Retry Tip';
                            }
                        };
                    } else {
                        const input = modal.querySelector('#ws-comment-input');
                        input.focus();
                        
                        modal.querySelector('#ws-modal-cancel').onclick = () => {
                            close();
                            resolve({ error: 'User cancelled' });
                        };
                        
                        modal.querySelector('#ws-modal-post').onclick = async () => {
                            const text = input.value;
                            if (!text.trim()) return;
                            
                            const btn = modal.querySelector('#ws-modal-post');
                            btn.textContent = 'Posting...';
                            btn.disabled = true;
                            
                            try {
                                const res = await originalFetch('/api/comments', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({
                                        content: text,
                                        parentId: data.parent_comment_id
                                    })
                                });
                                
                                if (!res.ok) {
                                    const errData = await res.json().catch(() => ({}));
                                    throw new Error(errData.error || 'Server Error ' + res.status);
                                }

                                const json = await res.json();
                                
                                // Emit local event
                                const user = await window.websim.getCurrentUser();
                                const evt = {
                                    comment: {
                                        id: json.id || 'temp_' + Date.now(),
                                        raw_content: text,
                                        author: user,
                                        created_at: new Date().toISOString(),
                                        parent_comment_id: data.parent_comment_id
                                    }
                                };
                                
                                const listeners = window._websim_comment_listeners || [];
                                listeners.forEach(cb => cb(evt));
                                
                                close();
                                resolve({});
                            } catch(e) {
                                console.error("Comment Post Failed:", e);
                                alert("Failed to post comment: " + e.message);
                                btn.textContent = 'Retry';
                                btn.disabled = false;
                            }
                        };
                    }
                });
            },
            addEventListener: (event, cb) => {
                if (event === 'comment:created') {
                     if (!window._websim_comment_listeners) window._websim_comment_listeners = [];
                     window._websim_comment_listeners.push(cb);
                }
            },

            collection: (name) => {
                // Return safe stubs to prevent crashes before hydration
                // If WebsimSocket exists (realtime.js), use it. Otherwise use generic DB stub.
                if (window.websimSocketInstance && typeof window.websimSocketInstance.collection === 'function') {
                    return window.websimSocketInstance.collection(name);
                }
                // Fallback / Pre-init stub
                return {
                    subscribe: (cb) => { if(cb) cb([]); return () => {}; }, 
                    getList: () => [], 
                    create: async () => ({}), 
                    update: async () => ({}), 
                    delete: async () => {}, 
                    filter: () => ({ subscribe: (cb) => { if(cb) cb([]); return () => {}; }, getList: () => [] })
                };
            },
            search: {
                assets: async (opts) => {
                    const params = new URLSearchParams();
                    if (opts.q) params.set('q', opts.q);
                    if (opts.mime_type_prefix) params.set('mime_type_prefix', opts.mime_type_prefix);
                    if (opts.limit) params.set('limit', opts.limit);
                    return fetch('/api/v1/search/assets?' + params.toString()).then(r => r.json());
                },
                relevant: async (opts) => {
                    const params = new URLSearchParams();
                    if (opts.q) params.set('q', opts.q);
                    if (opts.limit) params.set('limit', opts.limit);
                    return fetch('/api/v1/search/assets/relevant?' + params.toString()).then(r => r.json());
                }
            },
            upload: async (file) => {
                // Smart Upload: JSON persistence via Redis, Media via BlobURL (session)
                try {
                    let isJson = file.type === 'application/json' || (file.name && file.name.endsWith('.json'));
                    
                    if (!isJson && (!file.type || file.type === 'text/plain')) {
                        try {
                            // Quick sniff for JSON content
                            const text = await file.text();
                            const trimmed = text.trim();
                            if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
                                JSON.parse(trimmed);
                                isJson = true;
                            }
                        } catch(e) {}
                    }

                    if (isJson) {
                        const text = await file.text();
                        const data = JSON.parse(text);
                        // Generate ID
                        const key = 'up_' + Math.random().toString(36).substr(2, 9);
                        
                        // Upload to our custom JSON route
                        await fetch('/api/json/' + key, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(data)
                        });
                        
                        return '/api/json/' + key;
                    }
                    
                    // Fallback to Blob URL for images/audio (Session only)
                    return URL.createObjectURL(file);
                } catch(e) { 
                    console.error("Upload failed", e);
                    return ''; 
                }
            }
        };
    }
})();
`;