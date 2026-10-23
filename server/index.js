const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

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

    // Un giocatore entra nella stanza
    socket.on('player-join', ({ pin, nickname }) => {
        const room = rooms[pin];

        if (!room) {
            socket.emit('join-error', 'Stanza non trovata');
            return;
        }

        if (room.locked) {
            socket.emit('join-error', 'La stanza è chiusa, non è più possibile entrare');
            return;
        }

        room.players[socket.id] = { nickname, score: 0 };
        socket.join(pin);
        socket.data.pin = pin;
        console.log(`${nickname} è entrato nella stanza ${pin}`);

        socket.emit('join-success', { pin, nickname });

        const playerNames = Object.values(room.players).map(p => p.nickname);
        io.to(room.hostSocketId).emit('player-list-update', playerNames);
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
            const leaderboard = Object.values(room.players)
                .sort((a, b) => b.score - a.score)
                .map(p => ({ nickname: p.nickname, score: p.score }));

            io.to(pin).emit('game-over', leaderboard);
            return;
        }

        room.answers = {};
        room.questionStartTime = null; // il timer parte dopo l'immagine di introduzione

        // punteggio a inizio domanda: serve per animare i punti guadagnati nella classifica
        Object.values(room.players).forEach(p => { p.prevScore = p.score; });

        const isPuzzle = q.type === 'puzzle';
        if (isPuzzle) {
            room.puzzleOrder = generatePuzzleOrder(); // lo stesso mix per host e giocatori
            room.puzzleFirstDone = false;
        }

        // 1) immagine di introduzione: la mostra solo l'host, i telefoni restano vuoti
        clearTimeout(room.introTimer);
        clearTimeout(room.endTimer);
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
        io.to(pin).emit('new-question', {
            type: isPuzzle ? 'puzzle' : 'standard',
            question: q.question,
            options: q.options || [],
            timeLimit: q.timeLimit,
            totalPlayers: Object.keys(room.players).length,
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
                    totalPlayers: Object.keys(room.players).length
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

        socket.emit('answer-result', { correct: isCorrect, points });

        const totalPlayers = Object.keys(room.players).length;
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

        socket.emit('answer-result', { puzzle: true, correct: complete, correctCount, points });

        const totalPlayers = Object.keys(room.players).length;
        const totalAnswers = Object.keys(room.answers).length;
        io.to(room.hostSocketId).emit('answer-count-update', { totalAnswers, totalPlayers });
    });

    // L'host riavvia la partita nella stessa stanza
    socket.on('host-restart-game', ({ pin }) => {
        const room = rooms[pin];
        if (!room || room.hostSocketId !== socket.id) return;

        clearTimeout(room.introTimer);
        clearTimeout(room.endTimer);
        room.questionStartTime = null;
        room.currentQuestionIndex = -1;
        room.answers = {};
        room.locked = false;

        Object.values(room.players).forEach(p => p.score = 0);

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

    // Mostra la classifica intermedia
    socket.on('host-show-scoreboard', ({ pin }) => {
        const room = rooms[pin];
        if (!room || room.hostSocketId !== socket.id) return;

        clearTimeout(room.endTimer);

        const leaderboard = Object.values(room.players)
            .sort((a, b) => b.score - a.score)
            .map(p => ({
                nickname: p.nickname,
                score: p.score,
                previous: p.prevScore === undefined ? 0 : p.prevScore // punteggio prima di questa domanda
            }));

        io.to(pin).emit('scoreboard-update', leaderboard);
    });

    // L'host interrompe il gioco e torna subito alla lobby
    socket.on('host-stop-game', ({ pin }) => {
        const room = rooms[pin];
        if (!room || room.hostSocketId !== socket.id) return;

        clearTimeout(room.introTimer);
        clearTimeout(room.endTimer);
        room.questionStartTime = null;
        room.currentQuestionIndex = -1;
        room.answers = {};
        room.locked = false;

        Object.values(room.players).forEach(p => p.score = 0);

        console.log('Partita interrotta nella stanza', pin);
        io.to(pin).emit('game-stopped');
    });

    socket.on('disconnect', () => {
        console.log('Client disconnesso:', socket.id);

        const pin = socket.data.pin;
        const room = rooms[pin];
        if (!room) return;

        if (room.players[socket.id]) {
            delete room.players[socket.id];
            const playerNames = Object.values(room.players).map(p => p.nickname);
            io.to(room.hostSocketId).emit('player-list-update', playerNames);
        }
    });
});

function generatePin() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server avviato su http://localhost:${PORT}`);
});