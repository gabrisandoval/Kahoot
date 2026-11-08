// Scarica da GitHub le domande aggiornate (modificate dal telefono) e le salva in server/questions.json.
// Uso:  node server/sync.js     oppure     npm run sync
// Viene eseguito anche all'avvio del server (server/index.js).
//
// Configurazione: server/github.config.json  (vedi github.config.example.json)
//   { "owner": "...", "repo": "...", "branch": "main", "path": "server/questions.json", "token": "..." }
// Il token serve solo se il repository e' privato. In alternativa si possono usare le variabili
// d'ambiente GH_OWNER, GH_REPO, GH_BRANCH, GH_PATH, GH_TOKEN.

const fs = require('fs');
const path = require('path');

const QUESTIONS_FILE = path.join(__dirname, 'questions.json');
const BACKUP_FILE = path.join(__dirname, 'questions.backup.json');
const CONFIG_FILE = path.join(__dirname, 'github.config.json');

function loadConfig() {
    let c = {};
    try { c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')); } catch (e) { /* file assente */ }
    const cfg = {
        owner: process.env.GH_OWNER || c.owner,
        repo: process.env.GH_REPO || c.repo,
        branch: process.env.GH_BRANCH || c.branch || 'main',
        path: process.env.GH_PATH || c.path || 'server/questions.json',
        token: process.env.GH_TOKEN || c.token || ''
    };
    return cfg.owner && cfg.repo ? cfg : null;
}

// Restituisce { status: 'updated' | 'unchanged' | 'skipped' | 'error', message }
async function syncQuestions() {
    const cfg = loadConfig();
    if (!cfg) {
        return { status: 'skipped', message: 'Sincronizzazione con GitHub non configurata (manca server/github.config.json)' };
    }

    const encPath = cfg.path.split('/').map(encodeURIComponent).join('/');
    const url = 'https://api.github.com/repos/' + encodeURIComponent(cfg.owner) + '/' + encodeURIComponent(cfg.repo) +
        '/contents/' + encPath + '?ref=' + encodeURIComponent(cfg.branch);
    const headers = {
        'Accept': 'application/vnd.github.raw+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'quiz-live-sync'
    };
    if (cfg.token) headers['Authorization'] = 'Bearer ' + cfg.token;

    try {
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
        if (!res.ok) {
            const hint = res.status === 404 ? ' (controlla owner, repo, branch, percorso; se il repo e\' privato serve il token)'
                : res.status === 401 ? ' (token non valido)' : '';
            return { status: 'error', message: 'GitHub ha risposto ' + res.status + hint };
        }
        const text = await res.text();

        const data = JSON.parse(text);
        if (!Array.isArray(data)) return { status: 'error', message: 'Il file su GitHub non e\' una lista di domande' };

        let current = null;
        try { current = fs.readFileSync(QUESTIONS_FILE, 'utf-8'); } catch (e) { /* non esiste ancora */ }
        const next = JSON.stringify(data, null, 2);
        if (current !== null) {
            try {
                if (JSON.stringify(JSON.parse(current), null, 2) === next) {
                    return { status: 'unchanged', message: 'Domande gia\' aggiornate (' + data.length + ')' };
                }
            } catch (e) { /* file locale rovinato: lo sostituisco */ }
            fs.writeFileSync(BACKUP_FILE, current);   // copia di sicurezza di quello che c'era prima
        }
        const tmp = QUESTIONS_FILE + '.tmp';
        fs.writeFileSync(tmp, next);
        fs.renameSync(tmp, QUESTIONS_FILE);
        return { status: 'updated', message: 'Domande aggiornate da GitHub (' + data.length + ')' };
    } catch (e) {
        return { status: 'error', message: 'Sincronizzazione non riuscita: ' + (e.name === 'TimeoutError' ? 'timeout' : e.message) };
    }
}

module.exports = { syncQuestions };

if (require.main === module) {
    syncQuestions().then(r => {
        console.log('[sync] ' + r.message);
        process.exit(r.status === 'error' ? 1 : 0);
    });
}
