const { Pool } = require("pg");

// Configuração do Pool de conexões (Singleton pattern implícito)
const pool = new Pool({
    connectionString: process.env.CONNECTION_STRING,
    max: 20, // Máximo de conexões simultâneas
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

/**
 * Função utilitária para gerar código de sala (ex: XJ3K9M)
 */
function generateGameCode(length = 6) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

/**
 * AÇÃO 2: Criar uma Nova Partida
 * Cria a sessão, o estado da nação e insere o primeiro jogador (Criador).
 */
async function createGame(userUid, playerName) {
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN'); // Inicia Transação

        // 1. Gerar código único e criar Sessão
        let gameCode = generateGameCode();
        // Loop simples para garantir unicidade (embora colisão seja rara)
        let codeExists = true;
        while(codeExists) {
            const res = await client.query('SELECT 1 FROM game_sessions WHERE game_code = $1', [gameCode]);
            if(res.rowCount === 0) codeExists = false;
            else gameCode = generateGameCode();
        }

        const sessionRes = await client.query(`
            INSERT INTO game_sessions (game_code, status, creator_user_uid, current_turn, current_player_index)
            VALUES ($1, 'waiting', $2, 1, 0)
            RETURNING id, game_code
        `, [gameCode, userUid]);

        const sessionId = sessionRes.rows[0].id;

        // 2. Criar Estado da Nação Inicial (Valores padrão definidos no SQL)
        await client.query(`
            INSERT INTO nation_states (game_session_id)
            VALUES ($1)
        `, [sessionId]);

        // 3. Inserir o Jogador Criador
        await client.query(`
            INSERT INTO players (game_session_id, name, user_uid, character_role, capital)
            VALUES ($1, $2, $3, 'Presidente', 50) -- Exemplo de role inicial
        `, [sessionId, playerName, userUid]);

        await client.query('COMMIT'); // Salva tudo
        return { success: true, gameCode, sessionId };

    } catch (e) {
        await client.query('ROLLBACK'); // Desfaz se der erro
        console.error("Erro ao criar jogo:", e);
        throw e;
    } finally {
        client.release();
    }
}

/**
 * AÇÃO 3: Entrar em uma Partida Existente
 * Verifica status, lotação e se o usuário já está nela.
 */
async function joinGame(gameCode, userUid, playerName) {
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');

        // 1. Buscar Sessão
        const sessionRes = await client.query(`
            SELECT id, status FROM game_sessions WHERE game_code = $1 FOR UPDATE
        `, [gameCode]); // 'FOR UPDATE' trava a linha para evitar condições de corrida

        if (sessionRes.rowCount === 0) throw new Error("Partida não encontrada.");
        const session = sessionRes.rows[0];

        if (session.status !== 'waiting') throw new Error("A partida já começou ou terminou.");

        // 2. Verificar Jogadores Atuais
        const playersRes = await client.query(`
            SELECT user_uid FROM players WHERE game_session_id = $1
        `, [session.id]);

        if (playersRes.rows.length >= 4) throw new Error("A sala está cheia.");
        
        const alreadyJoined = playersRes.rows.some(p => p.user_uid === userUid);
        if (alreadyJoined) {
             await client.query('ROLLBACK');
             return { success: true, message: "Reconectado à sala." }; // Apenas retorna sucesso se já estiver lá
        }

        // 3. Inserir Novo Jogador
        await client.query(`
            INSERT INTO players (game_session_id, name, user_uid, capital)
            VALUES ($1, $2, $3, 10)
        `, [session.id, playerName, userUid]);

        await client.query('COMMIT');
        return { success: true, sessionId: session.id };

    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}

/**
 * Leitura de Estado (Polling ou Load inicial)
 * Busca todos os dados necessários para renderizar a tela do jogo.
 * Equivalente ao 'onSnapshot' do Firebase, mas chamado via GET.
 */
async function getFullGameState(gameCode) {
    const client = await pool.connect();
    try {
        // Busca Session + Nation State
        const sessionQuery = `
            SELECT 
                gs.id as session_id, gs.game_code, gs.status, gs.current_turn, gs.current_player_index, gs.creator_user_uid,
                ns.economy, ns.education, ns.wellbeing, ns.popular_support, ns.hunger, ns.military_religion, ns.board_position
            FROM game_sessions gs
            JOIN nation_states ns ON ns.game_session_id = gs.id
            WHERE gs.game_code = $1
        `;
        
        const sessionRes = await client.query(sessionQuery, [gameCode]);
        if (sessionRes.rowCount === 0) return null;

        const sessionData = sessionRes.rows[0];

        // Busca Jogadores
        const playersRes = await client.query(`
            SELECT id, name, character_role, capital, user_uid 
            FROM players 
            WHERE game_session_id = $1
            ORDER BY id ASC -- Importante manter a ordem para o índice do turno
        `, [sessionData.session_id]);

        // Busca Carta Atual (A primeira não resolvida ordenado por ordem)
        // Se usar sorteio dinâmico, essa lógica pode mudar.
        const cardRes = await client.query(`
            SELECT dc.title, dc.dilemma, dc.ethical_choice_effect, dc.corrupt_choice_effect, sdc.id as session_card_id
            FROM session_decision_cards sdc
            JOIN decision_cards dc ON dc.id = sdc.decision_card_id
            WHERE sdc.game_session_id = $1 AND sdc.is_resolved = FALSE
            ORDER BY sdc.order_num ASC
            LIMIT 1
        `, [sessionData.session_id]);

        return {
            ...sessionData,
            players: playersRes.rows,
            currentCard: cardRes.rows[0] || null
        };

    } finally {
        client.release();
    }
}

/**
 * AÇÃO 4: Aplicar Decisão (Turno)
 * Recebe o objeto de mudanças calculadas pelo backend (Express) e aplica atomicamente.
 */
async function applyTurnDecision(gameCode, updateData) {
    // updateData espera:
    // {
    //   playerId: UUID,
    //   newStats: { economy: 5, ... },
    //   capitalChange: -10,
    //   sessionCardId: UUID (carta resolvida),
    //   nextPlayerIndex: 1,
    //   incrementTurn: boolean
    // }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Pegar ID da Sessão
        const sessionRes = await client.query('SELECT id FROM game_sessions WHERE game_code = $1', [gameCode]);
        const sessionId = sessionRes.rows[0].id;

        // 2. Atualizar Nação
        const s = updateData.newStats;
        if (s) {
            await client.query(`
                UPDATE nation_states 
                SET economy = $1, education = $2, wellbeing = $3, popular_support = $4, 
                    hunger = $5, military_religion = $6, board_position = $7
                WHERE game_session_id = $8
            `, [s.economy, s.education, s.wellbeing, s.popular_support, s.hunger, s.military_religion, s.board_position, sessionId]);
        }

        // 3. Atualizar Capital do Jogador
        if (updateData.capitalChange !== 0) {
            await client.query(`
                UPDATE players SET capital = capital + $1 WHERE id = $2
            `, [updateData.capitalChange, updateData.playerId]);
        }

        // 4. Marcar carta como resolvida
        if (updateData.sessionCardId) {
            await client.query(`
                UPDATE session_decision_cards SET is_resolved = TRUE WHERE id = $1
            `, [updateData.sessionCardId]);
        }

        // 5. Passar Turno
        let turnSql = `UPDATE game_sessions SET current_player_index = $1`;
        const params = [updateData.nextPlayerIndex];
        
        if (updateData.incrementTurn) {
            turnSql += `, current_turn = current_turn + 1`;
        }
        turnSql += ` WHERE id = $2`;
        params.push(sessionId);

        await client.query(turnSql, params);

        await client.query('COMMIT');
        return { success: true };

    } catch (e) {
        await client.query('ROLLBACK');
        console.error(e);
        throw e;
    } finally {
        client.release();
    }
}

/**
 * AÇÃO 5: Reiniciar Partida
 * Reseta nação, deleta jogadores extras (exceto criador), reinicia deck.
 */
async function restartGame(gameCode, userUid) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Verifica se é o dono
        const sessionRes = await client.query(`SELECT id, creator_user_uid FROM game_sessions WHERE game_code = $1`, [gameCode]);
        const session = sessionRes.rows[0];
        
        if (session.creator_user_uid !== userUid) {
            throw new Error("Apenas o criador pode reiniciar.");
        }

        // 1. Resetar Sessão
        await client.query(`
            UPDATE game_sessions 
            SET status = 'waiting', current_turn = 1, current_player_index = 0
            WHERE id = $1
        `, [session.id]);

        // 2. Resetar Nação (Valores padrão 5)
        await client.query(`
            UPDATE nation_states
            SET economy=5, education=5, wellbeing=5, popular_support=5, hunger=5, military_religion=5, board_position=0
            WHERE game_session_id = $1
        `, [session.id]);

        // 3. Remover jogadores não-donos (Opcional: ou apenas resetar o capital de todos)
        // Opção A: Resetar capital de todos e manter na sala
        await client.query(`UPDATE players SET capital = 0 WHERE game_session_id = $1`, [session.id]);
        
        // 4. Resetar Cartas e Bosses
        await client.query(`DELETE FROM session_decision_cards WHERE game_session_id = $1`, [session.id]);
        await client.query(`DELETE FROM session_active_bosses WHERE game_session_id = $1`, [session.id]);
        // Aqui você chamaria a função para sortear novas cartas (populateDeck)

        await client.query('COMMIT');
        return { success: true };

    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}

module.exports = {
    createGame,
    joinGame,
    getFullGameState,
    applyTurnDecision,
    restartGame
};