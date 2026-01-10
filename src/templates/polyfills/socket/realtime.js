export const socketRealtime = `
    // ------------------------------------------------------------------------
    // 1. WebsimSocket (Realtime Multiplayer)
    // ------------------------------------------------------------------------
    class WebsimSocket {
        constructor() {
            this.presence = {};
            this.roomState = {};
            this.peers = {};
            this.clientId = 'user-' + Math.random().toString(36).substr(2, 9);
            this.listeners = {
                presence: new Set(),
                roomState: new Set(),
                updateRequest: new Set(),
                message: null
            };
            this.socket = null;
            this.subscription = null; // connectRealtime returns a disposable subscription, not a bidirectional channel
            this.isConnected = false;
            
            // Throttling state
            this._lastUpdateSent = 0;
            this._updatePending = false;

            // Singleton logic
            if (window.websimSocketInstance) {
                return window.websimSocketInstance;
            }
            window.websimSocketInstance = this;
        }

        async initialize() {
            console.log("[WebSim] Initializing Realtime Socket...");
            try {
                console.log("[WebSim] Connecting to realtime channel 'global_room'...");
                const connectRealtime = window.connectRealtime;

                if (!connectRealtime) throw new Error("connectRealtime not available - verify polyfill header");

                // Devvit Web Client (WebView) connectRealtime only receives messages.
                // It does NOT return a channel with .send().
                this.subscription = await connectRealtime({
                    channel: 'global_room',
                    onMessage: (msg) => {
                        // console.log("[WebSim] Raw Socket Msg:", msg); 
                        this._handleMessage(msg);
                    },
                    onConnect: () => {
                        console.log("[WebSim] Realtime Connected. ClientID:", this.clientId);
                        this.isConnected = true;
                        this._announceJoin();
                    },
                    onDisconnect: () => {
                        console.log("[WebSim] Realtime Disconnected");
                        this.isConnected = false;
                    }
                });
                
                // If onConnect isn't triggered immediately or we need to assume connectivity for optimistic UI
                this.isConnected = true;
                
                // CRITICAL FIX: Wait for identity so room.peers is populated before initialize() resolves.
                // This prevents race conditions where games check room.peers immediately after init.
                await this._announceJoin();

            } catch (e) {
                console.warn("[WebSim] Realtime init failed:", e);
                // Fallback: Local loopback for single player testing
                this.clientId = 'local-player';
                this.peers[this.clientId] = {
                    username: 'Player',
                    avatarUrl: 'https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png'
                };
                // Ensure we still try to announce locally
                this._announceJoin();
            }
        }

        // --- Public API ---

        async _sendToServer(payload) {
            // In Devvit Web, client cannot send directly. Must fetch to server, which broadcasts via realtime plugin.
            try {
                // console.log("[WebSim] Sending to Server:", payload.type);
                const res = await fetch('/api/realtime/message', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                if (!res.ok) console.error("[WebSim] RT Send Failed:", res.status);
            } catch(e) {
                console.error("[WebSim] RT Send Error:", e);
            }
        }

        updatePresence(data) {
            // 1. Update Local
            this.presence[this.clientId] = { ...this.presence[this.clientId], ...data };
            this._notifyPresence();

            // 2. Broadcast via Server (Throttled)
            if (this.isConnected) {
                this._schedulePresenceUpdate();
            }
        }

        _schedulePresenceUpdate() {
            if (this._updatePending) return;
            
            const now = Date.now();
            const INTERVAL = 80; // ~12Hz limit to respect Reddit rate limits (100msg/s shared)
            const timeSinceLast = now - this._lastUpdateSent;

            if (timeSinceLast >= INTERVAL) {
                this._sendPresence();
            } else {
                this._updatePending = true;
                setTimeout(() => {
                    this._updatePending = false;
                    this._sendPresence();
                }, INTERVAL - timeSinceLast);
            }
        }

        _sendPresence() {
            this._lastUpdateSent = Date.now();
            // Send aggregated local state to ensure eventual consistency
            // This handles cases where intermediate updates were throttled
            this._sendToServer({
                type: '_ws_presence',
                clientId: this.clientId,
                user: window._currentUser,
                payload: this.presence[this.clientId]
            });
        }

        updateRoomState(data) {
            // 1. Update Local
            this.roomState = { ...this.roomState, ...data };
            this._notifyRoomState();

            // 2. Broadcast via Server
            if (this.isConnected) {
                this._sendToServer({
                    type: '_ws_roomstate',
                    payload: data
                });
            }
        }

        requestPresenceUpdate(targetClientId, update) {
            if (this.isConnected) {
                this._sendToServer({
                    type: '_ws_req_update',
                    targetId: targetClientId,
                    fromId: this.clientId,
                    payload: update
                });
            }
        }

        send(event) {
            // Ephemeral Events
            if (this.isConnected) {
                this._sendToServer({
                    type: '_ws_event',
                    clientId: this.clientId,
                    username: window._currentUser?.username || 'Guest',
                    data: event
                });
            }
        }

        // --- Subscriptions ---

        subscribePresence(cb) {
            this.listeners.presence.add(cb);
            // Immediate callback
            try { cb(this.presence); } catch(e){}
            return () => this.listeners.presence.delete(cb);
        }

        subscribeRoomState(cb) {
            this.listeners.roomState.add(cb);
            try { cb(this.roomState); } catch(e){}
            return () => this.listeners.roomState.delete(cb);
        }

        subscribePresenceUpdateRequests(cb) {
            this.listeners.updateRequest.add(cb);
            return () => this.listeners.updateRequest.delete(cb);
        }
        
        set onmessage(cb) {
            this.listeners.message = cb;
        }

        // --- Internal Handlers ---

        _handleMessage(msg) {
            // Devvit Realtime usually sends the JSON object directly in recent versions,
            // but sometimes it's wrapped in an event object { message: ... } or { data: ... }
            
            let data = msg;
            if (msg.message) data = msg.message;
            else if (msg.data && !msg.type) data = msg.data; // Careful not to unwrap our own { type, data } payload prematurely

            console.log("[WebSim] RT Recv:", JSON.stringify(data).substring(0, 100));

            const type = data.type;

            if (type === '_ws_presence') {
                const { clientId, payload: presenceData, user } = data;
                
                // Update Peers List
                if (user) {
                    const originalName = user.username;
                    let displayName = originalName;
                    
                    // Simple duplicate handler: 
                    // If this client isn't in our list yet, or the name matches what we have, 
                    // check if the name collides with OTHERS.
                    
                    // Filter other peers to check collisions
                    const others = Object.values(this.peers).filter(p => p.id !== clientId);
                    const names = new Set(others.map(p => p.username));
                    
                    if (names.has(displayName)) {
                        let i = 2;
                        while (names.has(\`\${displayName} (\${i})\`)) i++;
                        displayName = \`\${displayName} (\${i})\`;
                    }
                    
                    this.peers[clientId] = {
                        id: clientId,
                        username: displayName,
                        avatarUrl: sanitizeAvatar(user.avatar_url, originalName) // Keep orig for PFP lookup
                    };
                }

                // Merge Presence
                // Fix: Merge payload (game state) instead of envelope to ensure x,y,z are at root
                this.presence[clientId] = { ...this.presence[clientId], ...presenceData };
                this._notifyPresence();
            }
            else if (type === '_ws_roomstate') {
                this.roomState = { ...this.roomState, ...data.payload };
                this._notifyRoomState();
            }
            else if (type === '_ws_req_update') {
                if (data.targetId === this.clientId) {
                    this.listeners.updateRequest.forEach(cb => cb(data.payload, data.fromId));
                }
            }
            else if (type === '_ws_event') {
                if (this.listeners.message) {
                    // Reconstruct WebSim event shape
                    const evt = {
                        data: {
                            ...data.data,
                            clientId: data.clientId,
                            username: data.username
                        }
                    };
                    this.listeners.message(evt);
                }
            }
        }

        _notifyPresence() {
            this.listeners.presence.forEach(cb => cb(this.presence));
        }

        _notifyRoomState() {
            this.listeners.roomState.forEach(cb => cb(this.roomState));
        }

        async _announceJoin() {
            // Wait for identity
            let tries = 0;
            while (!window._currentUser && tries < 10) {
                await new Promise(r => setTimeout(r, 100));
                tries++;
            }
            
            const user = window._currentUser || { username: 'Guest', avatar_url: '' };
            
            let displayName = user.username;
            // Check collisions with existing peers
            const others = Object.values(this.peers).filter(p => p.id !== this.clientId);
            const names = new Set(others.map(p => p.username));
            
            if (names.has(displayName)) {
                let i = 2;
                while (names.has(\`\${displayName} (\${i})\`)) i++;
                displayName = \`\${displayName} (\${i})\`;
            }

            this.peers[this.clientId] = {
                id: this.clientId,
                username: displayName,
                avatarUrl: sanitizeAvatar(user.avatar_url, user.username)
            };

            this.updatePresence({ joined: true });
        }
        
        // Collection stub for mixed usage
        collection(name) {
             return window.GenericDB.getAdapter(name);
        }
        
        static updateIdentity(user) {
            // Ensure we store a safe URL in the shared state
            if (user) {
                if (user.avatar_url) {
                    user.avatar_url = sanitizeAvatar(user.avatar_url, user.username);
                }
                // Polyfill camelCase for consistency with some game ports
                if (user.avatar_url && !user.avatarUrl) {
                    user.avatarUrl = user.avatar_url;
                }
            }
            window._currentUser = user;
            const inst = window.websimSocketInstance;
            if (inst && inst.peers[inst.clientId]) {
                inst.peers[inst.clientId].username = user.username;
                inst.peers[inst.clientId].avatarUrl = user.avatar_url;
                inst.updatePresence({}); // Trigger broadcast with new info
            }
        }
    }

    // Expose Global Class
    window.WebsimSocket = WebsimSocket;

    // Auto-instantiate if needed (often games use new WebsimSocket())
    // But some games access window.party directly.
    // We'll create a lazy instance and start it.
    if (!window.party) {
         window.party = new WebsimSocket();
         // Start connection automatically
         window.party.initialize();
    }
`;