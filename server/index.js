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
    newQuestion.id = Date.now().toString(); // NUOVO: id unico basato sul timestamp
    questions.push(newQuestion);
    fs.writeFileSync(QUESTIONS_FILE, JSON.stringify(questions, null, 2));
}

// NUOVO: elimina una domanda tramite id
function deleteQuestion(id) {
    const questions = loadQuestions();
    const filtered = questions.filter(q => q.id !== id);
    fs.writeFileSync(QUESTIONS_FILE, JSON.stringify(filtered, null, 2));
}

// NUOVO: modifica una domanda esistente
function updateQuestion(id, updatedFields) {
    const questions = loadQuestions();
    const index = questions.findIndex(q => q.id === id);
    if (index === -1) return false;

    questions[index] = { ...questions[index], ...updatedFields, id };
    fs.writeFileSync(QUESTIONS_FILE, JSON.stringify(questions, null, 2));
    return true;
}

app.use(express.json()); // NUOVO: per leggere dati JSON dal form

// Restituisce tutte le domande salvate
app.get('/api/questions', (req, res) => {
    res.json(loadQuestions());
});

//elimina una domanda
app.delete('/api/questions/:id', (req, res) => {
    deleteQuestion(req.params.id);
    res.json({ success: true });
});

// modifica una domanda
app.put('/api/questions/:id', (req, res) => {
    const { question, options, correctIndex, timeLimit } = req.body;
    const success = updateQuestion(req.params.id, { question, options, correctIndex, timeLimit });
    res.json({ success });
});

// Aggiunge una nuova domanda
app.post('/api/questions', (req, res) => {
    const { question, options, correctIndex, timeLimit } = req.body;
    saveQuestion({ question, options, correctIndex, timeLimit });
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

    // Un giocatore entra nella stanza + aggiungi il punteggio
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
        socket.data.pin = pin; // NUOVO: ci serve per rimuoverlo alla disconnessione
        console.log(`${nickname} è entrato nella stanza ${pin}`);

        socket.emit('join-success', { pin, nickname });

        const playerNames = Object.values(room.players).map(p => p.nickname);
        io.to(room.hostSocketId).emit('player-list-update', playerNames);
    });

    // L'host invia la prossima domanda, salvato orario di invio della domanda
    socket.on('host-next-question', ({ pin }) => {
        const room = rooms[pin];
        if (!room || room.hostSocketId !== socket.id) return;

        room.locked = true;

        const QUESTIONS = loadQuestions();

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
            timeLimit: q.timeLimit
        });
    });

    // Un giocatore risponde, punteggio valutato in base al tempo di risposta
    socket.on('submit-answer', ({ pin, answerIndex }) => {
        const room = rooms[pin];
        if (!room) return;

        if (room.answers[socket.id] !== undefined) return;

        const timeTaken = (Date.now() - room.questionStartTime) / 1000;
        room.answers[socket.id] = answerIndex;

        const QUESTIONS = loadQuestions(); // NUOVO
        const q = QUESTIONS[room.currentQuestionIndex];
        const isCorrect = answerIndex === q.correctIndex;

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

    // NUOVO: l'host riavvia la partita nella stessa stanza
    socket.on('host-restart-game', ({ pin }) => {
        const room = rooms[pin];
        if (!room || room.hostSocketId !== socket.id) return;

        room.currentQuestionIndex = -1;
        room.answers = {};
        room.locked = false; // NUOVO: riapri la stanza per nuovi giocatori

        Object.values(room.players).forEach(p => p.score = 0);

        console.log('Partita riavviata nella stanza', pin);
        io.to(pin).emit('game-restarted');
    });

    socket.on('host-toggle-lock', ({ pin }) => {
        const room = rooms[pin];
        if (!room || room.hostSocketId !== socket.id) return;

        room.locked = !room.locked;
        console.log('Stanza', pin, room.locked ? 'bloccata' : 'sbloccata');
        socket.emit('lock-status-update', { locked: room.locked });
    });

    // NUOVO: la pagina di gioco (play.html) reclama il controllo della stanza
    socket.on('host-rejoin', ({ pin }) => {
        const room = rooms[pin];
        if (!room) return;

        room.hostSocketId = socket.id;
        socket.join(pin);

        const playerNames = Object.values(room.players).map(p => p.nickname);
        socket.emit('host-rejoin-success', { pin, locked: room.locked, players: playerNames });
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