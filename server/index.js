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
        correctIndex: 1,
        timeLimit: 15      //secondi
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

    // Un giocatore entra nella stanza + aggiungi il punteggio
    socket.on('player-join', ({ pin, nickname }) => {
        const room = rooms[pin];

        if (!room) {
            socket.emit('join-error', 'Stanza non trovata');
            return;
        }

        room.players[socket.id] = { nickname, score: 0 };
        socket.join(pin);
        console.log(`${nickname} è entrato nella stanza ${pin}`);

        socket.emit('join-success', { pin, nickname });

        const playerNames = Object.values(room.players).map(p => p.nickname);
        io.to(room.hostSocketId).emit('player-list-update', playerNames);
    });

    // L'host invia la prossima domanda, salvato orario di invio della domanda
    socket.on('host-next-question', ({ pin }) => {
        const room = rooms[pin];
        if (!room || room.hostSocketId !== socket.id) return;

        room.currentQuestionIndex++;
        const q = QUESTIONS[room.currentQuestionIndex];

        if (!q) {
            // NUOVO: costruiamo la classifica finale e la mandiamo a tutti
            const leaderboard = Object.values(room.players)
                .sort((a, b) => b.score - a.score) // ordina dal punteggio più alto
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

        // calcola quanti secondi ha impiegato a rispondere
        const timeTaken = (Date.now() - room.questionStartTime) / 1000;
        room.answers[socket.id] = answerIndex;

        const q = QUESTIONS[room.currentQuestionIndex];
        const isCorrect = answerIndex === q.correctIndex;

        let points = 0;
        if (isCorrect) {
            // NUOVO: 500 punti base + fino a 500 di bonus velocità
            const speedBonus = Math.max(0, q.timeLimit - timeTaken) / q.timeLimit;
            points = Math.round(500 + 500 * speedBonus);
            room.players[socket.id].score += points;
        }

        // punti aggiunti
        socket.emit('answer-result', { correct: isCorrect, points });

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