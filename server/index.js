const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, '..', 'public')));

// Domande di esempio
const QUESTIONS = [
    {
        question: 'Qual è la capitale d\'Italia?',
        options: ['Milano', 'Roma', 'Napoli', 'Torino'],
        correctIndex: 1
    }
];

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
            answers: {}
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

        room.players[socket.id] = nickname;
        socket.join(pin);
        console.log(`${nickname} è entrato nella stanza ${pin}`);

        socket.emit('join-success', { pin, nickname });

        const playerNames = Object.values(room.players);
        io.to(room.hostSocketId).emit('player-list-update', playerNames);
    });

    // L'host invia la prossima domanda
    socket.on('host-next-question', ({ pin }) => {
        const room = rooms[pin];
        if (!room || room.hostSocketId !== socket.id) return;

        room.currentQuestionIndex++;
        const q = QUESTIONS[room.currentQuestionIndex];

        if (!q) {
            console.log('Domande finite');
            return;
        }

        room.answers = {};

        io.to(pin).emit('new-question', {
            question: q.question,
            options: q.options
        });
    });

    // Un giocatore risponde
    socket.on('submit-answer', ({ pin, answerIndex }) => {
        const room = rooms[pin];
        if (!room) return;

        if (room.answers[socket.id] !== undefined) return;

        room.answers[socket.id] = answerIndex;

        const q = QUESTIONS[room.currentQuestionIndex];
        const isCorrect = answerIndex === q.correctIndex;

        socket.emit('answer-result', { correct: isCorrect });

        const totalPlayers = Object.keys(room.players).length;
        const totalAnswers = Object.keys(room.answers).length;
        io.to(room.hostSocketId).emit('answer-count-update', { totalAnswers, totalPlayers });
    });

    socket.on('disconnect', () => {
        console.log('Client disconnesso:', socket.id);
    });
});

function generatePin() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Server avviato su http://localhost:${PORT}`);
});