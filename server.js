const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static('public'));

// ============ GITHUB YEDEKLEME AYARLARI ============
const GITHUB_TOKEN = "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";
const GITHUB_REPO = "4detrail/z0nk";
const GITHUB_BACKUP_FILE = "backup/chat_data.json";

// ============ ADMIN AYARLARI ============
const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "HeXaHack2026!";

// Veri dosyaları
let users = [];
let rooms = [];
let messages = [];
let userRooms = [];
let userActivity = {};
let userRoles = {}; // { "username": { role: "admin", assignedBy: "creator", roomCode: "room_code" } }

// ============ SPAM KORUMASI ============
let lastMessageTime = {};
const MESSAGE_COOLDOWN = 2000;

// ============ YEDEKLEME FONKSİYONLARI ============
async function backupToGitHub() {
    try {
        const backupData = {
            users: users,
            rooms: rooms,
            messages: messages,
            userRooms: userRooms,
            userActivity: userActivity,
            userRoles: userRoles,
            lastBackup: new Date().toISOString()
        };
        
        let sha = null;
        try {
            const getRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_BACKUP_FILE}`, {
                headers: {
                    'Authorization': `Bearer ${GITHUB_TOKEN}`,
                    'Accept': 'application/vnd.github.v3+json'
                }
            });
            if (getRes.ok) {
                const data = await getRes.json();
                sha = data.sha;
            }
        } catch(e) {}
        
        const content = Buffer.from(JSON.stringify(backupData, null, 2)).toString('base64');
        const putRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_BACKUP_FILE}`, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${GITHUB_TOKEN}`,
                'Content-Type': 'application/json',
                'Accept': 'application/vnd.github.v3+json'
            },
            body: JSON.stringify({
                message: `Backup - ${new Date().toISOString()}`,
                content: content,
                sha: sha
            })
        });
        
        if (putRes.ok) {
            console.log(`✅ GitHub yedekleme başarılı - ${new Date().toLocaleTimeString()}`);
        }
    } catch(e) {
        console.error("GitHub yedekleme hatası:", e.message);
    }
}

async function restoreFromGitHub() {
    try {
        const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_BACKUP_FILE}`, {
            headers: {
                'Authorization': `Bearer ${GITHUB_TOKEN}`,
                'Accept': 'application/vnd.github.v3+json'
            }
        });
        
        if (res.ok) {
            const data = await res.json();
            const content = Buffer.from(data.content, 'base64').toString('utf8');
            const backupData = JSON.parse(content);
            
            users = backupData.users || [];
            rooms = backupData.rooms || [];
            messages = backupData.messages || [];
            userRooms = backupData.userRooms || [];
            userActivity = backupData.userActivity || {};
            userRoles = backupData.userRoles || {};
            
            console.log(`✅ GitHub'dan geri yükleme başarılı - ${users.length} kullanıcı, ${rooms.length} oda`);
            saveData();
            return true;
        }
    } catch(e) {
        console.log("GitHub geri yükleme yapılamadı (ilk çalıştırma olabilir)");
    }
    return false;
}

// ============ DOSYA İŞLEMLERİ ============
const loadData = () => {
    try {
        if(fs.existsSync('users.json')) users = JSON.parse(fs.readFileSync('users.json', 'utf8'));
        if(fs.existsSync('rooms.json')) rooms = JSON.parse(fs.readFileSync('rooms.json', 'utf8'));
        if(fs.existsSync('messages.json')) messages = JSON.parse(fs.readFileSync('messages.json', 'utf8'));
        if(fs.existsSync('userRooms.json')) userRooms = JSON.parse(fs.readFileSync('userRooms.json', 'utf8'));
        if(fs.existsSync('userActivity.json')) userActivity = JSON.parse(fs.readFileSync('userActivity.json', 'utf8'));
        if(fs.existsSync('userRoles.json')) userRoles = JSON.parse(fs.readFileSync('userRoles.json', 'utf8'));
    } catch(e) {}
};

const saveData = () => {
    fs.writeFileSync('users.json', JSON.stringify(users, null, 2));
    fs.writeFileSync('rooms.json', JSON.stringify(rooms, null, 2));
    fs.writeFileSync('messages.json', JSON.stringify(messages, null, 2));
    fs.writeFileSync('userRooms.json', JSON.stringify(userRooms, null, 2));
    fs.writeFileSync('userActivity.json', JSON.stringify(userActivity, null, 2));
    fs.writeFileSync('userRoles.json', JSON.stringify(userRoles, null, 2));
};

// Admin kullanıcıyı oluştur (eğer yoksa)
const ensureAdminUser = async () => {
    const adminExists = users.find(u => u.username === ADMIN_USERNAME);
    if (!adminExists) {
        const hashed = await bcrypt.hash(ADMIN_PASSWORD, 10);
        users.push({ username: ADMIN_USERNAME, password: hashed, created_at: new Date().toISOString(), isAdmin: true });
        userRoles[ADMIN_USERNAME] = { role: "admin", assignedBy: "system", roomCode: null };
        saveData();
        console.log("✅ Admin kullanıcı oluşturuldu!");
    } else if (!userRoles[ADMIN_USERNAME]) {
        userRoles[ADMIN_USERNAME] = { role: "admin", assignedBy: "system", roomCode: null };
        saveData();
    }
};

// Kullanıcının belirli bir odadaki rolünü al
const getUserRoleInRoom = (username, roomCode) => {
    if (username === ADMIN_USERNAME) return "admin";
    if (userRoles[username] && userRoles[username].roomCode === roomCode) {
        return userRoles[username].role;
    }
    // Oda kurucusu kontrolü
    const room = rooms.find(r => r.room_code === roomCode);
    if (room && room.created_by === username) return "room_creator";
    return "user";
};

// Kullanıcının admin olup olmadığını kontrol et (global admin)
const isGlobalAdmin = (username) => {
    return username === ADMIN_USERNAME;
};

// ============ OTOMATİK YEDEKLEME (Her 5 dakika) ============
setInterval(() => {
    if (users.length > 0 || rooms.length > 0) {
        backupToGitHub();
    }
}, 5 * 60 * 1000);

// ============ OTOMATİK MESAJ SİLME (20 dakika) ============
setInterval(() => {
    const now = new Date();
    const twentyMinsAgo = new Date(now.getTime() - 20 * 60 * 1000);
    const beforeCount = messages.length;
    
    messages = messages.filter(msg => {
        const msgDate = new Date(msg.timestamp);
        return msgDate > twentyMinsAgo;
    });
    
    if (messages.length !== beforeCount) {
        console.log(`🗑️ ${beforeCount - messages.length} eski mesaj silindi (20 dakika)`);
        saveData();
        backupToGitHub();
    }
}, 60 * 1000);

// ============ AFK kontrolü (10 dakika) ============
setInterval(() => {
    const now = Date.now();
    for (const [username, lastActive] of Object.entries(userActivity)) {
        if (now - lastActive > 10 * 60 * 1000) {
            const idx = userRooms.findIndex(u => u.username === username);
            if (idx !== -1) {
                const room = rooms.find(r => r.room_code === userRooms[idx].current_room);
                if (room && room.users) {
                    const userIdx = room.users.indexOf(username);
                    if (userIdx !== -1) room.users.splice(userIdx, 1);
                }
                userRooms.splice(idx, 1);
                console.log(`🗑️ ${username} AFK olduğu için odadan atıldı`);
            }
            delete userActivity[username];
            saveData();
        }
    }
}, 60 * 1000);

// ============ Oda kodu üretici ============
function generateRoomCode() {
    const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const numbers = '0123456789';
    let code = '#';
    for(let i = 0; i < 2; i++) code += letters[Math.floor(Math.random() * letters.length)];
    for(let i = 0; i < 3; i++) code += numbers[Math.floor(Math.random() * numbers.length)];
    return code;
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============ KULLANICILAR ============
app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if(!username || !password) return res.status(400).json({ error: 'Kullanıcı adı ve şifre gerekli!' });
    if(username === ADMIN_USERNAME) return res.status(400).json({ error: 'Bu kullanıcı adı alınamaz!' });
    if(users.find(u => u.username === username)) return res.status(400).json({ error: 'Kullanıcı var!' });
    
    const hashed = await bcrypt.hash(password, 10);
    users.push({ username, password: hashed, created_at: new Date().toISOString() });
    saveData();
    backupToGitHub();
    res.json({ success: true });
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const user = users.find(u => u.username === username);
    if(!user) return res.status(401).json({ error: 'Kullanıcı bulunamadı!' });
    
    const validPass = await bcrypt.compare(password, user.password);
    if(!validPass) return res.status(401).json({ error: 'Hatalı şifre!' });
    
    const token = jwt.sign({ username }, 'GIZLI_ANAHTAR', { expiresIn: '24h' });
    userActivity[username] = Date.now();
    saveData();
    res.json({ token, username, isAdmin: username === ADMIN_USERNAME });
});

app.post('/update_activity', (req, res) => {
    const { username, token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        userActivity[username] = Date.now();
        saveData();
        res.json({ success: true });
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

// ============ ODALAR ============
app.post('/create_room', async (req, res) => {
    const { username, room_name, room_password, is_private, token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        let room_code;
        do { room_code = generateRoomCode(); } while(rooms.find(r => r.room_code === room_code));
        
        const hashedPassword = room_password ? await bcrypt.hash(room_password, 10) : null;
        
        rooms.push({ 
            room_code, 
            room_name, 
            room_password: hashedPassword,
            is_private: is_private || false,
            created_by: username, 
            created_at: new Date().toISOString(),
            users: [username]
        });
        saveData();
        backupToGitHub();
        res.json({ success: true, room_code });
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

app.post('/join_room', async (req, res) => {
    const { username, room_code, room_password, token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        const room = rooms.find(r => r.room_code === room_code);
        if(!room) return res.status(404).json({ error: 'Oda bulunamadı!' });
        
        // Admin her odaya şifresiz girebilir
        if (!isGlobalAdmin(username) && room.room_password) {
            if (!room_password) return res.status(401).json({ error: 'Bu oda şifreli! Şifre girin!' });
            const valid = await bcrypt.compare(room_password, room.room_password);
            if (!valid) return res.status(401).json({ error: 'Oda şifresi hatalı!' });
        }
        
        const idx = userRooms.findIndex(u => u.username === username);
        if(idx !== -1) userRooms[idx].current_room = room_code;
        else userRooms.push({ username, current_room: room_code });
        
        if (!room.users.includes(username)) room.users.push(username);
        
        userActivity[username] = Date.now();
        saveData();
        res.json({ success: true, room_code });
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

app.post('/delete_room', (req, res) => {
    const { username, room_code, token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        const room = rooms.find(r => r.room_code === room_code);
        if(!room) return res.status(404).json({ error: 'Oda bulunamadı!' });
        
        // Admin veya oda kurucusu silebilir
        if (!isGlobalAdmin(username) && room.created_by !== username) {
            return res.status(403).json({ error: 'Bu odayı sadece oluşturan kişi veya admin silebilir!' });
        }
        
        const deletedMsgCount = messages.filter(m => m.room_code === room_code).length;
        messages = messages.filter(m => m.room_code !== room_code);
        
        for (const user of room.users) {
            const urIdx = userRooms.findIndex(u => u.username === user && u.current_room === room_code);
            if (urIdx !== -1) userRooms.splice(urIdx, 1);
        }
        
        const roomIdx = rooms.findIndex(r => r.room_code === room_code);
        rooms.splice(roomIdx, 1);
        
        console.log(`🗑️ Oda ${room_code} silindi, ${deletedMsgCount} mesaj temizlendi`);
        saveData();
        backupToGitHub();
        res.json({ success: true });
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

app.post('/current_room', (req, res) => {
    const { username, token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        const ur = userRooms.find(u => u.username === username);
        res.json({ room_code: ur ? ur.current_room : null });
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

app.post('/leave_room', (req, res) => {
    const { username, token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        
        const urIdx = userRooms.findIndex(u => u.username === username);
        if (urIdx !== -1) {
            const roomCode = userRooms[urIdx].current_room;
            const room = rooms.find(r => r.room_code === roomCode);
            if (room) {
                const userIdx = room.users.indexOf(username);
                if (userIdx !== -1) room.users.splice(userIdx, 1);
            }
            userRooms.splice(urIdx, 1);
        }
        
        saveData();
        res.json({ success: true });
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

// ============ LİSTELEME - Admin public ve private tüm odaları görebilir ============
app.post('/list_rooms', (req, res) => {
    const { token, username } = req.body;
    try {
        const decoded = jwt.verify(token, 'GIZLI_ANAHTAR');
        const isAdmin = isGlobalAdmin(decoded.username);
        
        let filteredRooms = rooms;
        if (!isAdmin) {
            filteredRooms = rooms.filter(r => !r.is_private);
        }
        
        const roomList = filteredRooms.map(r => ({
            room_code: r.room_code,
            room_name: r.room_name,
            created_by: r.created_by,
            is_locked: !!r.room_password,
            is_private: r.is_private || false,
            users_count: r.users ? r.users.filter(u => userActivity[u] && (Date.now() - userActivity[u] < 10 * 60 * 1000)).length : 0,
            total_users: r.users ? r.users.length : 0,
            message_count: messages.filter(m => m.room_code === r.room_code).length
        }));
        res.json(roomList);
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

app.post('/room_users', (req, res) => {
    const { room_code, token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        const room = rooms.find(r => r.room_code === room_code);
        if(!room) return res.json([]);
        
        const usersWithRoles = room.users.map(u => ({
            username: u,
            role: getUserRoleInRoom(u, room_code),
            isOnline: userActivity[u] && (Date.now() - userActivity[u] < 10 * 60 * 1000)
        }));
        
        res.json(usersWithRoles);
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

// ============ ROL YÖNETİMİ ============
app.post('/assign_role', (req, res) => {
    const { username, targetUsername, role, room_code, token } = req.body;
    try {
        const decoded = jwt.verify(token, 'GIZLI_ANAHTAR');
        const currentUser = decoded.username;
        
        // Yetki kontrolü: Admin veya oda kurucusu rol atayabilir
        const room = rooms.find(r => r.room_code === room_code);
        if (!room) return res.status(404).json({ error: 'Oda bulunamadı!' });
        
        const canAssign = isGlobalAdmin(currentUser) || room.created_by === currentUser;
        if (!canAssign) {
            return res.status(403).json({ error: 'Rol atama yetkiniz yok!' });
        }
        
        // Geçerli roller
        const validRoles = ['moderator', 'vip', 'user'];
        if (!validRoles.includes(role)) {
            return res.status(400).json({ error: 'Geçersiz rol!' });
        }
        
        userRoles[targetUsername] = {
            role: role,
            assignedBy: currentUser,
            roomCode: room_code,
            assignedAt: new Date().toISOString()
        };
        
        saveData();
        backupToGitHub();
        res.json({ success: true, message: `${targetUsername} kullanıcısına ${role} rolü verildi!` });
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

app.post('/remove_role', (req, res) => {
    const { username, targetUsername, room_code, token } = req.body;
    try {
        const decoded = jwt.verify(token, 'GIZLI_ANAHTAR');
        const currentUser = decoded.username;
        
        const room = rooms.find(r => r.room_code === room_code);
        if (!room) return res.status(404).json({ error: 'Oda bulunamadı!' });
        
        const canRemove = isGlobalAdmin(currentUser) || room.created_by === currentUser;
        if (!canRemove) {
            return res.status(403).json({ error: 'Rol silme yetkiniz yok!' });
        }
        
        if (userRoles[targetUsername] && userRoles[targetUsername].roomCode === room_code) {
            delete userRoles[targetUsername];
            saveData();
            backupToGitHub();
            res.json({ success: true, message: `${targetUsername} kullanıcısının rolü kaldırıldı!` });
        } else {
            res.json({ success: false, message: 'Bu kullanıcının bu odada rolü yok!' });
        }
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

app.post('/user_roles', (req, res) => {
    const { username, room_code, token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        const role = getUserRoleInRoom(username, room_code);
        res.json({ role });
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

// Tüm odalardaki kullanıcıları listele (admin için)
app.post('/admin_all_users', (req, res) => {
    const { token } = req.body;
    try {
        const decoded = jwt.verify(token, 'GIZLI_ANAHTAR');
        if (!isGlobalAdmin(decoded.username)) {
            return res.status(403).json({ error: 'Bu işlem için admin yetkisi gerekli!' });
        }
        
        const allUsersInfo = users.map(u => ({
            username: u.username,
            created_at: u.created_at,
            isOnline: userActivity[u.username] && (Date.now() - userActivity[u.username] < 10 * 60 * 1000),
            currentRoom: userRooms.find(ur => ur.username === u.username)?.current_room || null,
            globalRole: u.username === ADMIN_USERNAME ? 'admin' : 'user'
        }));
        
        res.json(allUsersInfo);
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

// ============ MESAJLAR (Admin etiketi ile) ============
app.post('/send', (req, res) => {
    const { from, message, token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        
        const now = Date.now();
        const lastTime = lastMessageTime[from] || 0;
        if (now - lastTime < MESSAGE_COOLDOWN && !isGlobalAdmin(from)) {
            return res.status(429).json({ 
                error: `Lütfen ${Math.ceil((MESSAGE_COOLDOWN - (now - lastTime)) / 1000)} saniye bekleyin!`,
                waitTime: MESSAGE_COOLDOWN - (now - lastTime)
            });
        }
        
        const ur = userRooms.find(u => u.username === from);
        if(!ur || !ur.current_room) return res.status(400).json({ error: 'Önce bir odaya katılın!' });
        
        const room = rooms.find(r => r.room_code === ur.current_room);
        if (!room) {
            return res.status(400).json({ error: 'Oda silinmiş!' });
        }
        
        lastMessageTime[from] = now;
        userActivity[from] = Date.now();
        
        const userRole = getUserRoleInRoom(from, ur.current_room);
        const isAdminGlobal = isGlobalAdmin(from);
        
        messages.push({ 
            room_code: ur.current_room, 
            from_user: from, 
            message, 
            timestamp: new Date().toISOString(),
            role: isAdminGlobal ? '👑 ADMIN' : (userRole === 'room_creator' ? '👑 KURUCU' : (userRole === 'moderator' ? '🛡️ MOD' : (userRole === 'vip' ? '💎 VIP' : '')))
        });
        
        saveData();
        res.json({ success: true });
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

app.post('/messages', (req, res) => {
    const { username, token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        const ur = userRooms.find(u => u.username === username);
        if(!ur || !ur.current_room) return res.json([]);
        
        userActivity[username] = Date.now();
        
        const roomMessages = messages
            .filter(m => m.room_code === ur.current_room)
            .slice(-100);
        
        res.json(roomMessages);
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

app.post('/logout', (req, res) => {
    const { username, token } = req.body;
    try {
        jwt.verify(token, 'GIZLI_ANAHTAR');
        const idx = userRooms.findIndex(u => u.username === username);
        if (idx !== -1) {
            const room = rooms.find(r => r.room_code === userRooms[idx].current_room);
            if (room) {
                const userIdx = room.users.indexOf(username);
                if (userIdx !== -1) room.users.splice(userIdx, 1);
            }
            userRooms.splice(idx, 1);
        }
        delete userActivity[username];
        delete lastMessageTime[username];
        saveData();
        res.json({ success: true });
    } catch(e) { res.status(401).json({ error: 'Yetkisiz!' }); }
});

// ============ SUNUCU BAŞLAT ============
const PORT = process.env.PORT || 3000;

(async () => {
    await restoreFromGitHub();
    loadData();
    await ensureAdminUser();
    console.log(`\n🔥 HEXAHACK IAIM CHAT SİSTEMİ AKTİF!`);
    console.log(`📍 http://localhost:${PORT}`);
    console.log(`👑 Admin: ${ADMIN_USERNAME} / ${ADMIN_PASSWORD}`);
    console.log(`⏰ Mesajlar 20 dakika sonra otomatik silinecek`);
    console.log(`🗑️ AFK kullanıcılar 10 dakika sonra atılacak`);
    console.log(`💾 GitHub yedekleme aktif - Her 5 dakikada bir yedekleniyor`);
    console.log(`🛡️ Spam koruması aktif - ${MESSAGE_COOLDOWN/1000} saniye bekleme süresi`);
    console.log(`🔒 Private oda sistemi aktif - Admin tüm odaları görebilir`);
    console.log(`🎭 Rol sistemi aktif - Oda kurucuları rol atayabilir`);
    console.log(`📁 Yedekler: https://github.com/${GITHUB_REPO}/tree/master/backup`);
    
    app.listen(PORT, '0.0.0.0', () => {});
})();