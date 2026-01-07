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
        const { userUid, playerName } = req.body;

        if (!userUid || !playerName) {
            return res.status(400).json({ error: "UID e Nome são obrigatórios." });
        }

        const result = await db.createGame(userUid, playerName);
        
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
        // choice deve ser 'ethical' ou 'corrupt'

        if (!['ethical', 'corrupt'].includes(choice)) {
            return res.status(400).json({ error: "Escolha inválida." });
        }

        // 1. Busca estado atual para validar regras
        const gameState = await db.getFullGameState(gameCode);
        if (!gameState) return res.status(404).json({ error: "Jogo não encontrado." });

        // 2. Validação: É a vez desse usuário?
        const currentPlayer = gameState.players[gameState.current_player_index];
        
        // Se não houver jogador (erro de indice) ou UID não bater
        if (!currentPlayer || currentPlayer.user_uid !== userUid) {
            return res.status(403).json({ error: "Não é sua vez de jogar." });
        }

        if (!gameState.currentCard) {
            return res.status(400).json({ error: "Não há carta ativa para resolver." });
        }

        // 3. Calcular Efeitos (Regra de Negócio)
        // Pega os efeitos do JSON salvo no banco
        const effects = choice === 'ethical' 
            ? gameState.currentCard.ethical_choice_effect 
            : gameState.currentCard.corrupt_choice_effect;

        // Função auxiliar para garantir limites 0 a 10
        const clamp = (val) => Math.min(10, Math.max(0, val));

        const newStats = {
            economy: clamp(gameState.economy + (effects.economy || 0)),
            education: clamp(gameState.education + (effects.education || 0)),
            wellbeing: clamp(gameState.wellbeing + (effects.wellbeing || 0)),
            popular_support: clamp(gameState.popular_support + (effects.popular_support || 0)),
            hunger: clamp(gameState.hunger + (effects.hunger || 0)),
            military_religion: clamp(gameState.military_religion + (effects.military_religion || 0)),
            board_position: gameState.board_position // Posição pode mudar se tiver dado, etc.
        };

        // Capital muda? (Ex: Corrupção ganha dinheiro, Ética perde ou mantém)
        const capitalChange = effects.capital || 0;

        // 4. Calcular Próximo Turno
        const totalPlayers = gameState.players.length;
        let nextPlayerIndex = gameState.current_player_index + 1;
        let incrementTurn = false;

        if (nextPlayerIndex >= totalPlayers) {
            nextPlayerIndex = 0;
            incrementTurn = true; // Completou uma rodada na mesa
        }

        // 5. Aplicar no Banco
        const updateData = {
            playerId: currentPlayer.id,
            newStats: newStats,
            capitalChange: capitalChange,
            sessionCardId: gameState.currentCard.session_card_id,
            nextPlayerIndex: nextPlayerIndex,
            incrementTurn: incrementTurn
        };

        await db.applyTurnDecision(gameCode, updateData);

        res.json({ 
            success: true, 
            message: "Decisão aplicada.",
            effectsApplied: effects
        });

    } catch (error) {
        console.error("Erro na decisão:", error);
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