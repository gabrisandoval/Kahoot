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

// salva il nuovo ordine delle domande
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
    const { question, options, correctIndex, timeLimit, imageData } = req.body;
    const success = updateQuestion(req.params.id, { question, options, correctIndex, timeLimit, imageData });
    res.json({ success });
});

// aggiunge una nuova domanda
app.post('/api/questions', (req, res) => {
    const { question, options, correctIndex, timeLimit, imageData } = req.body;
    saveQuestion({ question, options, correctIndex, timeLimit, imageData });
    res.json({ success: true });
});

// Memoria delle stanze attive
// rooms[pin] = { hostSocketId, players: {}, currentQuestionIndex, answers: {} }
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

        const QUESTIONS = loadQuestions().filter(q => q.enabled !== false);

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
        room.questionStartTime = Date.now();

        io.to(pin).emit('new-question', {
            question: q.question,
            options: q.options,
            timeLimit: q.timeLimit,
            totalPlayers: Object.keys(room.players).length,
            imageData: q.imageData || null
        });
    });

    // Un giocatore risponde
    socket.on('submit-answer', ({ pin, answerIndex }) => {
        const room = rooms[pin];
        if (!room) return;

        if (room.answers[socket.id] !== undefined) return;

        const timeTaken = (Date.now() - room.questionStartTime) / 1000;
        room.answers[socket.id] = answerIndex;

        const QUESTIONS = loadQuestions().filter(q => q.enabled !== false);
        const q = QUESTIONS[room.currentQuestionIndex];

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

    // L'host riavvia la partita nella stessa stanza
    socket.on('host-restart-game', ({ pin }) => {
        const room = rooms[pin];
        if (!room || room.hostSocketId !== socket.id) return;

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

        const leaderboard = Object.values(room.players)
            .sort((a, b) => b.score - a.score)
            .map(p => ({ nickname: p.nickname, score: p.score }));

        io.to(pin).emit('scoreboard-update', leaderboard);
    });

    // L'host interrompe il gioco e torna subito alla lobby
    socket.on('host-stop-game', ({ pin }) => {
        const room = rooms[pin];
        if (!room || room.hostSocketId !== socket.id) return;

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

const PORT = 3000;
server.listen(PORT, () => {
    //console.log(`Server avviato su http://localhost:${PORT}`);
    console.log(`Server avviato su https://reunite-gray-reaffirm.ngrok-free.dev/index.html`);

});