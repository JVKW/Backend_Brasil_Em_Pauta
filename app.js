require('dotenv').config();
const express = require("express");
const cors = require("cors");
const db = require("./db");

const app = express();
const port = process.env.PORT || 3000;

// Middleware para processar JSON e permitir requisições do frontend
app.use(express.json());
app.use(cors());

// =======================================================
// ROTA 1: CRIAR PARTIDA
// =======================================================
app.post("/game/create", async (req, res) => {
    try {
        const { userUid, playerName, isObserver } = req.body;

        if (!userUid || !playerName) {
            return res.status(400).json({ error: "UID e Nome são obrigatórios." });
        }

        const result = await db.createGame(userUid, playerName, isObserver);
        
        console.log(`Jogo criado: ${result.gameCode} por ${playerName}`);
        res.status(201).json(result);

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Erro ao criar partida." });
    }
});

// =======================================================
// ROTA 2: ENTRAR NA PARTIDA
// =======================================================
app.post("/game/join", async (req, res) => {
    try {
        // userUid vem do Firebase no front, playerName digita no input
        const { gameCode, userUid, playerName } = req.body;

        if (!gameCode || !userUid || !playerName) {
            return res.status(400).json({ error: "Dados incompletos." });
        }

        const result = await db.joinGame(gameCode.toUpperCase(), userUid, playerName);
        
        res.status(200).json(result);

    } catch (error) {
        console.error(error);
        // Retorna erro 400 para erros de lógica (sala cheia, jogo já começou)
        // e 500 para erros de banco
        const status = error.message === "Partida não encontrada." ? 404 : 400;
        res.status(status).json({ error: error.message });
    }
});

// =======================================================
// ROTA 3: BUSCAR ESTADO (Polling)
// =======================================================
app.get("/game/:gameCode", async (req, res) => {
    try {
        const { gameCode } = req.params;
        const gameState = await db.getFullGameState(gameCode.toUpperCase());

        if (!gameState) {
            return res.status(404).json({ error: "Jogo não encontrado." });
        }

        res.json(gameState);

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Erro ao buscar estado do jogo." });
    }
});

// =======================================================
// ROTA 4: TOMAR DECISÃO (O coração da lógica)
// =======================================================
app.post("/game/decision", async (req, res) => {
    try {
        const { gameCode, userUid, choice } = req.body; 
        
        // Validação: Aceita apenas números inteiros (0 a 3)
        // O backend (db.js) fará a validação final se o índice existe no array da carta
        if (typeof choice !== 'number') {
             return res.status(400).json({ error: "A escolha deve ser o índice da opção (número)." });
        }

        const result = await db.processDecision(gameCode.toUpperCase(), userUid, choice);
        
        res.json({ 
            success: true, 
            message: "Decisão aplicada.",
            gameState: result // Retorna o novo estado (stats, nextCard, status)
        });

    } catch (error) {
        console.error("Erro na decisão:", error);
        // Tratamento de erros específicos de regra de negócio
        if (error.message.includes("Não é o seu turno") || error.message.includes("Jogo não está ativo")) {
            return res.status(403).json({ error: error.message });
        }
        res.status(500).json({ error: "Erro ao processar jogada." });
    }
});

// =======================================================
// ROTA 5: REINICIAR PARTIDA
// =======================================================
app.post("/game/restart", async (req, res) => {
    try {
        const { gameCode, userUid } = req.body;
        
        await db.restartGame(gameCode, userUid);
        
        res.json({ message: "Jogo reiniciado com sucesso." });

    } catch (error) {
        // Se o erro for "Apenas o criador pode reiniciar", retorna 403
        const status = error.message.includes("criador") ? 403 : 500;
        res.status(status).json({ error: error.message });
    }
});


// =======================================================
// ROTAS DE BOSS (Do seu código original)
// =======================================================
app.get("/boss/:id", async (req, res) => {
    try {
        res.json({ message: "Rota de boss implementada, falta query SQL" });
    } catch (e) {
        res.status(500).send(e.message);
    }
});

app.listen(port, () => {
    console.log(`Servidor rodando na porta ${port}`);
});


// =======================================================
// ROTA 6: INICIAR PARTIDA (Mudar status para in_progress)
// =======================================================
app.post("/game/start", async (req, res) => {
    try {
        /* #swagger.parameters['body'] = {
            in: 'body',
            description: 'Inicia a partida mudando status para in_progress',
            schema: {
                gameCode: 'ABC123'
            }
        } */

        const { gameCode } = req.body;

        if (!gameCode) {
            return res.status(400).json({ error: "O código da partida é obrigatório." });
        }

        await db.startGame(gameCode);
        
        res.json({ 
            success: true, 
            message: "Partida iniciada com sucesso! Status alterado para in_progress." 
        });

    } catch (error) {
        console.error(error);
        // Retorna 400 se for erro de lógica (jogo não encontrado/já iniciado) ou 500 se for erro de banco
        const status = error.message.includes("Não foi possível") ? 404 : 500;
        res.status(status).json({ error: error.message });
    }
});