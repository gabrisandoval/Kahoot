## PROGETTO KAHOOT

# Struttura Progetto
1. BackEnd: Node.js + Express + Socket.io
2. FrontEnd: React
3. Database: 
4. Express(libreria per far funzionare il server web)
    SERVER: Node.js + Express
5. Ngrok = tunnel per accesso in altri dispositivi 

# Attivare il progetto
1. terminal 1:node server/index.js
2. terminal 2: ngrok http 3000

# Il piano
1. Server Express minimo — una pagina che risponde
2. Aggiungere Socket.IO — verificare che client e server comunicano
3. L'host crea una stanza — genera un PIN
4. Un giocatore entra nella stanza — con PIN e nickname
5. L'host invia una domanda — tutti i giocatori la ricevono
6. I giocatori rispondono — il server calcola chi ha risposto
7. Calcolo punteggio — con bonus velocità
8. Classifica finale

CREAZIONE BASE DI KAHOOT: DONE

Aggiunte:
9. Pagina per aggiungere/eliminare/modificare domande(salvate su file)
10. Reset Game
11. Add T/F Questions
12. Add QR Code and link to play
13. Add CSS, gestione liste fantasma
14. Add features: size message, view number of players,
    at least 1 player playing, add new type of question
15. add sounds
16. gestione messaggi giocatore
17. domande disattivate
18. add mute button e volume adjustment