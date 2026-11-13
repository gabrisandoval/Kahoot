const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const { syncQuestions } = require('./sync');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, '..', 'public')));

const QUESTIONS_FILE = path.join(__dirname, 'questions.json');

function loadQuestions() {
    const data = fs.readFileSync(QUESTIONS_FILE, 'utf-8');
    return JSON.parse(data);
}

// Solo le domande attive (spuntate in questions.html)
function loadActiveQuestions() {
    return loadQuestions().filter(q => q.enabled !== false);
}

function saveQuestion(newQuestion) {
    const questions = loadQuestions();
    newQuestion.id = Date.now().toString();
    questions.push(newQuestion);
    fs.writeFileSync(QUESTIONS_FILE, JSON.stringify(questions, null, 2));
}

function deleteQuestion(id) {
    const questions = loadQuestions();
    const filtered = questions.filter(q => q.id !== id);
    fs.writeFileSync(QUESTIONS_FILE, JSON.stringify(filtered, null, 2));
}

function updateQuestion(id, updatedFields) {
    const questions = loadQuestions();
    const index = questions.findIndex(q => q.id === id);
    if (index === -1) return false;

    questions[index] = { ...questions[index], ...updatedFields, id };
    fs.writeFileSync(QUESTIONS_FILE, JSON.stringify(questions, null, 2));
    return true;
}

function reorderQuestions(orderedIds) {
    const questions = loadQuestions();
    const reordered = orderedIds
        .map(id => questions.find(q => q.id === id))
        .filter(q => q !== undefined);
    fs.writeFileSync(QUESTIONS_FILE, JSON.stringify(reordered, null, 2));
}

function toggleQuestionEnabled(id, enabled) {
    const questions = loadQuestions();
    const index = questions.findIndex(q => q.id === id);
    if (index === -1) return false;

    questions[index].enabled = enabled;
    fs.writeFileSync(QUESTIONS_FILE, JSON.stringify(questions, null, 2));
    return true;
}

app.use(express.json({ limit: '10mb' }));

// Restituisce tutte le domande salvate
app.get('/api/questions', (req, res) => {
    res.json(loadQuestions());
});

// elimina una domanda
app.delete('/api/questions/:id', (req, res) => {
    deleteQuestion(req.params.id);
    res.json({ success: true });
});

// salva il nuovo ordine delle domande (rotta specifica: PRIMA di /:id)
app.put('/api/questions/reorder', (req, res) => {
    const { orderedIds } = req.body;
    reorderQuestions(orderedIds);
    res.json({ success: true });
});

// attiva/disattiva una domanda
app.put('/api/questions/:id/toggle', (req, res) => {
    const { enabled } = req.body;
    const success = toggleQuestionEnabled(req.params.id, enabled);
    res.json({ success });
});

// modifica una domanda
app.put('/api/questions/:id', (req, res) => {
    const { type, question, options, correctIndex, timeLimit, imageData } = req.body;
    const success = updateQuestion(req.params.id, { type, question, options, correctIndex, timeLimit, imageData });
    res.json({ success });
});

// aggiunge una nuova domanda
app.post('/api/questions', (req, res) => {
    const { type, question, options, correctIndex, timeLimit, imageData } = req.body;
    saveQuestion({ type, question, options, correctIndex, timeLimit, imageData });
    res.json({ success: true });
});

// ---- PUZZLE 3x3 ----
// order[posizione] = numero del pezzo mostrato in quella posizione (0..8).
// Il puzzle e' risolto quando order[i] === i per ogni i.
function generatePuzzleOrder() {
    const order = [0, 1, 2, 3, 4, 5, 6, 7, 8];
    let fixedPoints;
    do {
        for (let i = order.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [order[i], order[j]] = [order[j], order[i]];
        }
        fixedPoints = order.filter((piece, pos) => piece === pos).length;
    } while (fixedPoints > 2); // evita puzzle gia' (quasi) risolti
    return order;
}

// Classifica ordinata per punti (a parita' di punti resta prima chi e' entrato prima)
function buildLeaderboard(room) {
    return Object.values(room.players)
        .map((p, i) => ({ p, i }))
        .sort((a, b) => (b.p.score - a.p.score) || (a.i - b.i))
        .map(({ p }) => p);
}

// Aspetta che arrivino le ultime risposte (puzzle inviati dal timer dei telefoni) prima di mostrare una classifica
function whenScoresSettled(room, fn) {
    clearTimeout(room.boardTimer);
    const wait = (room.settleAt || 0) - Date.now();
    if (wait > 0) room.boardTimer = setTimeout(fn, wait);
    else fn();
}

// Giocatori ancora collegati (quelli temporaneamente offline restano nella partita ma non contano nei totali)
function connectedCount(room) {
    return Object.values(room.players).filter(p => p.connected !== false).length;
}

function playerNames(room) {
    return Object.values(room.players).map(p => p.nickname);
}

// Dopo un rientro: rimanda al telefono cio' che sta succedendo (domanda in corso, risultato, classifica finale)
function sendPlayerState(room, socket, player) {
    if (room.gameOver) {
        const leaderboard = buildLeaderboard(room).map(p => ({ nickname: p.nickname, score: p.score }));
        socket.emit('game-over', leaderboard);
        return;
    }
    const q = loadActiveQuestions()[room.currentQuestionIndex];
    if (!q || !room.questionStartTime) return; // in attesa / immagine di introduzione: arrivera' new-question

    const remaining = Math.ceil(q.timeLimit - (Date.now() - room.questionStartTime) / 1000);
    const answered = room.answers[socket.id] !== undefined;
    const isPuzzle = q.type === 'puzzle';

    if (remaining > 0) {
        socket.emit('new-question', {
            type: isPuzzle ? 'puzzle' : 'standard',
            question: q.question,
            options: q.options || [],
            timeLimit: remaining,
            totalPlayers: connectedCount(room),
            imageData: q.imageData || null,
            puzzleOrder: isPuzzle ? room.puzzleOrder : null,
            questionNumber: room.currentQuestionIndex + 1,
            totalQuestions: loadActiveQuestions().length,
            answered
        });
        if (answered && player.lastResult) socket.emit('answer-result', player.lastResult);
    } else {
        // tempo scaduto: mostra il risultato se c'e', altrimenti attende la prossima domanda
        socket.emit('rejoin-wait', { result: player.lastResult || null });
    }
}

// Durata dell'immagine di introduzione prima di ogni domanda (millisecondi)
const INTRO_MS = 3000;

// Tipo di domanda: decide quale immagine mostrare (public/intro/<tipo>.jpg)
function getQuestionKind(q) {
    if (q.type === 'puzzle') return 'puzzle';
    if (q.imageData) return 'image';
    if (q.options && q.options.length === 2 && q.options[0] === 'Vero' && q.options[1] === 'Falso') return 'truefalse';
    return 'multiple';
}

function isValidPuzzleArrangement(arr) {
    if (!Array.isArray(arr) || arr.length !== 9) return false;
    const seen = new Set();
    for (const v of arr) {
        if (!Number.isInteger(v) || v < 0 || v > 8 || seen.has(v)) return false;
        seen.add(v);
    }
    return true;
}

// Memoria delle stanze attive
const rooms = {};

io.on('connection', (socket) => {
    console.log('Nuovo client connesso:', socket.id);

    // L'host crea una nuova stanza
    socket.on('host-create-room', () => {
        const pin = generatePin();

        rooms[pin] = {
            hostSocketId: socket.id,
            players: {},
            currentQuestionIndex: -1,
            answers: {},
            locked: false
        };

        socket.join(pin);
        console.log('Stanza creata con PIN:', pin);
        socket.emit('room-created', { pin });
    });

    // Un giocatore entra nella stanza (o rientra dopo una disconnessione)
    socket.on('player-join', ({ pin, nickname, playerId }) => {
        const room = rooms[pin];

        if (!room) {
            socket.emit('join-error', 'Stanza non trovata');
            return;
        }

        // Rientro: stesso giocatore (stesso playerId, oppure stesso nome di un giocatore offline)
        let oldId = null;
        for (const [sid, p] of Object.entries(room.players)) {
            if (playerId && p.playerId === playerId) { oldId = sid; break; }
        }
        if (!oldId) {
            for (const [sid, p] of Object.entries(room.players)) {
                if (p.connected === false && p.nickname === nickname && (!playerId || !p.playerId)) { oldId = sid; break; }
            }
        }

        if (oldId) {
            const p = room.players[oldId];
            if (oldId !== socket.id) {
                delete room.players[oldId];
                room.players[socket.id] = p;
                if (room.answers[oldId] !== undefined) {
                    room.answers[socket.id] = room.answers[oldId];
                    delete room.answers[oldId];
                }
            }
            clearTimeout(p.dropTimer);
            p.connected = true;
            if (playerId) p.playerId = playerId;
            socket.join(pin);
            socket.data.pin = pin;
            console.log(`${p.nickname} e' rientrato nella stanza ${pin}`);

            socket.emit('join-success', { pin, nickname: p.nickname, rejoined: true });
            sendPlayerState(room, socket, p);
            io.to(room.hostSocketId).emit('player-list-update', playerNames(room));
            return;
        }

        // Nuovo giocatore: possibile solo se la stanza non e' chiusa
        if (room.locked) {
            socket.emit('join-error', 'La stanza è chiusa, non è più possibile entrare');
            return;
        }

        room.players[socket.id] = { nickname, score: 0, playerId: playerId || null, connected: true };
        socket.join(pin);
        socket.data.pin = pin;
        console.log(`${nickname} è entrato nella stanza ${pin}`);

        socket.emit('join-success', { pin, nickname });

        io.to(room.hostSocketId).emit('player-list-update', playerNames(room));
    });

    // L'host invia la prossima domanda
    socket.on('host-next-question', ({ pin }) => {
        const room = rooms[pin];
        if (!room || room.hostSocketId !== socket.id) return;

        room.locked = true;

        const QUESTIONS = loadActiveQuestions();

        room.currentQuestionIndex++;
        const q = QUESTIONS[room.currentQuestionIndex];

        if (!q) {
            whenScoresSettled(room, () => {
                const leaderboard = buildLeaderboard(room)
                    .map(p => ({ nickname: p.nickname, score: p.score }));
                room.gameOver = true;
                io.to(pin).emit('game-over', leaderboard);
            });
            return;
        }

        room.answers = {};
        room.questionStartTime = null; // il timer parte dopo l'immagine di introduzione

        // punteggio a inizio domanda: serve per animare i punti guadagnati nella classifica
        Object.values(room.players).forEach(p => { p.prevScore = p.score; p.lastResult = null; });
        room.gameOver = false;

        const isPuzzle = q.type === 'puzzle';
        if (isPuzzle) {
            room.puzzleOrder = generatePuzzleOrder(); // lo stesso mix per host e giocatori
            room.puzzleFirstDone = false;
        }

        // 1) immagine di introduzione: la mostra solo l'host, i telefoni restano vuoti
        clearTimeout(room.introTimer);
        clearTimeout(room.endTimer);
        clearTimeout(room.boardTimer);
        room.settleAt = 0;
        io.to(pin).emit('round-intro', {
            kind: getQuestionKind(q),
            questionNumber: room.currentQuestionIndex + 1,
            totalQuestions: QUESTIONS.length,
            introMs: INTRO_MS
        });

        // 2) poi esce la domanda e parte il tempo
        room.introTimer = setTimeout(() => {
            room.questionStartTime = Date.now();
            sendQuestion();
        }, INTRO_MS);

        function sendQuestion() {
        // dopo questo istante tutte le risposte (anche i puzzle inviati dal timer dei telefoni) sono arrivate
        room.settleAt = Date.now() + q.timeLimit * 1000 + (isPuzzle ? 3300 : 600);
        io.to(pin).emit('new-question', {
            type: isPuzzle ? 'puzzle' : 'standard',
            question: q.question,
            options: q.options || [],
            timeLimit: q.timeLimit,
            totalPlayers: connectedCount(room),
            imageData: q.imageData || null,
            puzzleOrder: isPuzzle ? room.puzzleOrder : null,
            questionNumber: room.currentQuestionIndex + 1,
            totalQuestions: QUESTIONS.length
        });

        // Allo scadere del tempo l'host riceve quanti hanno scelto ogni opzione
        if (!isPuzzle) {
            clearTimeout(room.endTimer);
            room.endTimer = setTimeout(() => {
                const counts = (q.options || []).map(() => 0);
                Object.values(room.answers).forEach(a => {
                    if (Number.isInteger(a) && counts[a] !== undefined) counts[a]++;
                });
                io.to(room.hostSocketId).emit('question-ended', {
                    counts,
                    correctIndex: q.correctIndex,
                    totalPlayers: connectedCount(room)
                });
            }, q.timeLimit * 1000 + 400); // piccola tolleranza per le risposte in arrivo
        }
        }
    });

    // Un giocatore risponde (domande normali)
    socket.on('submit-answer', ({ pin, answerIndex }) => {
        const room = rooms[pin];
        if (!room || !room.players[socket.id]) return;

        if (room.answers[socket.id] !== undefined) return;
        if (!room.questionStartTime) return; // immagine di introduzione in corso

        const timeTaken = (Date.now() - room.questionStartTime) / 1000;

        const QUESTIONS = loadActiveQuestions();
        const q = QUESTIONS[room.currentQuestionIndex];
        if (!q || q.type === 'puzzle') return;

        room.answers[socket.id] = answerIndex;

        const withinTime = timeTaken <= q.timeLimit;
        const isCorrect = withinTime && answerIndex === q.correctIndex;

        let points = 0;
        if (isCorrect) {
            const speedBonus = Math.max(0, q.timeLimit - timeTaken) / q.timeLimit;
            points = Math.round(500 + 500 * speedBonus);
            room.players[socket.id].score += points;
        }

        const result = { correct: isCorrect, points };
        room.players[socket.id].lastResult = result;
        socket.emit('answer-result', result);

        const totalPlayers = connectedCount(room);
        const totalAnswers = Object.keys(room.answers).length;
        io.to(room.hostSocketId).emit('answer-count-update', { totalAnswers, totalPlayers });
    });

    // Un giocatore invia il puzzle
    // arrangement[posizione] = pezzo; auto = true se inviato dal timer scaduto
    socket.on('submit-puzzle', ({ pin, arrangement, auto }) => {
        const room = rooms[pin];
        if (!room || !room.players[socket.id]) return;
        if (room.answers[socket.id] !== undefined) return;
        if (!isValidPuzzleArrangement(arrangement)) return;
        if (!room.questionStartTime) return; // immagine di introduzione in corso

        const QUESTIONS = loadActiveQuestions();
        const q = QUESTIONS[room.currentQuestionIndex];
        if (!q || q.type !== 'puzzle') return;

        const timeTaken = (Date.now() - room.questionStartTime) / 1000;
        const tooLate = timeTaken > q.timeLimit + 3; // piccola tolleranza per la latenza di rete

        room.answers[socket.id] = arrangement;

        const correctCount = tooLate ? 0 : arrangement.filter((piece, pos) => piece === pos).length;
        const complete = correctCount === 9;

        // 100 punti a pezzo: puzzle completo = 900
        let points = correctCount * 100;

        // +100 (totale 1000) al primo che INVIA un puzzle completo entro il tempo
        if (complete && !auto && timeTaken <= q.timeLimit && !room.puzzleFirstDone) {
            points += 100;
            room.puzzleFirstDone = true;
        }

        room.players[socket.id].score += points;

        const result = { puzzle: true, correct: complete, correctCount, points };
        room.players[socket.id].lastResult = result;
        socket.emit('answer-result', result);

        const totalPlayers = connectedCount(room);
        const totalAnswers = Object.keys(room.answers).length;
        io.to(room.hostSocketId).emit('answer-count-update', { totalAnswers, totalPlayers });
    });

    // L'host riavvia la partita nella stessa stanza
    socket.on('host-restart-game', ({ pin }) => {
        const room = rooms[pin];
        if (!room || room.hostSocketId !== socket.id) return;

        clearTimeout(room.introTimer);
        clearTimeout(room.endTimer);
        clearTimeout(room.boardTimer);
        room.settleAt = 0;
        room.questionStartTime = null;
        room.currentQuestionIndex = -1;
        room.answers = {};
        room.locked = false;

        room.gameOver = false;
        Object.entries(room.players).forEach(([sid, p]) => {
            if (p.connected === false) delete room.players[sid]; // chi non e' piu tornato esce dalla stanza
            else p.score = 0;
        });
        io.to(room.hostSocketId).emit('player-list-update', playerNames(room));

        console.log('Partita riavviata nella stanza', pin);
        io.to(pin).emit('game-restarted');
    });

    // L'host blocca/sblocca la stanza
    socket.on('host-toggle-lock', ({ pin }) => {
        const room = rooms[pin];
        if (!room || room.hostSocketId !== socket.id) return;

        room.locked = !room.locked;
        console.log('Stanza', pin, room.locked ? 'bloccata' : 'sbloccata');
        socket.emit('lock-status-update', { locked: room.locked });
    });

    // La pagina di gioco (play.html) reclama il controllo della stanza
    socket.on('host-rejoin', ({ pin }) => {
        const room = rooms[pin];
        if (!room) return;

        room.hostSocketId = socket.id;
        socket.join(pin);

        const playerNames = Object.values(room.players).map(p => p.nickname);
        socket.emit('host-rejoin-success', { pin, locked: room.locked, players: playerNames });
    });

    // L'host si e' riconnesso (rete caduta, telefono/PC in standby): riprende il controllo senza ripartire
    socket.on('host-reclaim', ({ pin }) => {
        const room = rooms[pin];
        if (!room) return;
        room.hostSocketId = socket.id;
        socket.join(pin);
        socket.emit('player-list-update', playerNames(room));
    });

    // Mostra la classifica intermedia
    socket.on('host-show-scoreboard', ({ pin }) => {
        const room = rooms[pin];
        if (!room || room.hostSocketId !== socket.id) return;

        clearTimeout(room.endTimer);

        whenScoresSettled(room, () => {
            const leaderboard = buildLeaderboard(room)
                .map(p => ({
                    nickname: p.nickname,
                    score: p.score,
                    previous: p.prevScore === undefined ? 0 : p.prevScore // punteggio prima di questa domanda
                }));

            io.to(pin).emit('scoreboard-update', leaderboard);
        });
    });

    // L'host interrompe il gioco e torna subito alla lobby
    socket.on('host-stop-game', ({ pin }) => {
        const room = rooms[pin];
        if (!room || room.hostSocketId !== socket.id) return;

        clearTimeout(room.introTimer);
        clearTimeout(room.endTimer);
        clearTimeout(room.boardTimer);
        room.settleAt = 0;
        room.questionStartTime = null;
        room.currentQuestionIndex = -1;
        room.answers = {};
        room.locked = false;

        room.gameOver = false;
        Object.entries(room.players).forEach(([sid, p]) => {
            if (p.connected === false) delete room.players[sid]; // chi non e' piu tornato esce dalla stanza
            else p.score = 0;
        });
        io.to(room.hostSocketId).emit('player-list-update', playerNames(room));

        console.log('Partita interrotta nella stanza', pin);
        io.to(pin).emit('game-stopped');
    });

    socket.on('disconnect', () => {
        console.log('Client disconnesso:', socket.id);

        const pin = socket.data.pin;
        const room = rooms[pin];
        if (!room) return;

        const p = room.players[socket.id];
        if (!p) return;

        // Il giocatore NON viene eliminato: puo' rientrare e ritrova punteggio e domanda in corso.
        p.connected = false;

        if (room.currentQuestionIndex < 0 && !room.locked) {
            // in lobby, se non torna entro 30 secondi esce dall'elenco
            p.dropTimer = setTimeout(() => {
                if (p.connected === false && room.players[socket.id] === p) {
                    delete room.players[socket.id];
                    io.to(room.hostSocketId).emit('player-list-update', playerNames(room));
                }
            }, 30000);
        }
    });
});

function generatePin() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

const PORT = process.env.PORT || 3000;
// All'avvio scarica le domande aggiornate da GitHub (se configurato), poi parte il server.
// Se GitHub non e' raggiungibile si usano le domande gia' presenti in locale.
syncQuestions().then(result => {
    console.log('[sync] ' + result.message);
}).finally(() => {
    server.listen(PORT, () => {
        console.log(`Server avviato su http://localhost:${PORT}`);
    });
});