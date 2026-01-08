const { Pool } = require("pg");

const pool = new Pool({
    connectionString: process.env.CONNECTION_STRING,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
    ssl: { rejectUnauthorized: false }
});

// Helper
function generateGameCode(length = 6) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < length; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
    return result;
}

// LISTA DE PAPÉIS VÁLIDOS (Deve bater com o CHECK do banco de dados)
const AVAILABLE_ROLES = ['Ministro', 'General', 'Opositor', 'Empresário', 'Jornalista'];


/**
 * AÇÃO 2: Criar uma Nova Partida
 * Cria a sessão, o estado da nação e insere o primeiro jogador (Criador).
 */
async function createGame(userUid, playerName, isObserver = false) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        let gameCode = generateGameCode();
        let codeExists = true;
        while(codeExists) {
            const res = await client.query('SELECT 1 FROM game_sessions WHERE game_code = $1', [gameCode]);
            if(res.rowCount === 0) codeExists = false;
            else gameCode = generateGameCode();
        }

        // Cria a sessão.
        const sessionRes = await client.query(`
            INSERT INTO game_sessions (game_code, status, current_turn, current_player_index, creator_user_uid)
            VALUES ($1, 'waiting', 1, 0, $2)
            RETURNING id
        `, [gameCode, userUid]);
        const sessionId = sessionRes.rows[0].id;

        if (userUid && playerName) {
            if (isObserver) {
                // --- CAMINHO DO OBSERVADOR ---
                // Registra na tabela, mas sem capital, sem turno e role fixa
                await client.query(`
                    INSERT INTO players (session_id, nickname, user_uid, capital, character_role, turn_order)
                    VALUES ($1, $2, $3, 0, 'observador', NULL)
                `, [sessionId, playerName, userUid]);
            } else {
                // --- CAMINHO DO JOGADOR CRIADOR ---
                const randomRole = AVAILABLE_ROLES[Math.floor(Math.random() * AVAILABLE_ROLES.length)];
                await client.query(`
                    INSERT INTO players (session_id, nickname, user_uid, capital, character_role, turn_order)
                    VALUES ($1, $2, $3, 10, $4, 0)
                `, [sessionId, playerName, userUid, randomRole]);
            }
        }

        await client.query('COMMIT');
        return { success: true, gameCode, sessionId };
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}

/**
 * AÇÃO 3: Entrar em uma Partida Existente
 * Verifica status, lotação e atribui um papel único ao jogador.
 */
async function joinGame(gameCode, userUid, playerName) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const sessionRes = await client.query(`SELECT id, status FROM game_sessions WHERE game_code = $1 FOR UPDATE`, [gameCode]);
        if (sessionRes.rowCount === 0) throw new Error("Partida não encontrada.");
        const session = sessionRes.rows[0];

        // Se já estiver na sala (seja player ou observador), reconecta
        const checkPlayer = await client.query('SELECT 1 FROM players WHERE session_id = $1 AND user_uid = $2', [session.id, userUid]);
        if (checkPlayer.rowCount > 0) {
            await client.query('ROLLBACK');
            return { success: true, message: "Reconectado." };
        }

        if (session.status !== 'waiting') throw new Error("Partida já iniciada.");

        // Busca todos os jogadores atuais
        const playersRes = await client.query(`SELECT character_role FROM players WHERE session_id = $1`, [session.id]);
        
        // Filtra apenas quem REALMENTE joga (ignora observador)
        const activePlayers = playersRes.rows.filter(p => p.character_role !== 'observador');
        
        if (activePlayers.length >= 4) throw new Error("Sala cheia (máximo 4 jogadores).");

        // Define papéis disponíveis (excluindo os já usados por jogadores ativos)
        const usedRoles = activePlayers.map(p => p.character_role);
        const available = AVAILABLE_ROLES.filter(r => !usedRoles.includes(r));
        const assignedRole = available.length > 0 ? available[Math.floor(Math.random() * available.length)] : 'Cidadão';

        // O turn_order deve ser igual ao número de jogadores ATIVOS atuais (0, 1, 2, 3)
        // Se houver 1 observador e 0 jogadores, o próximo será turn_order 0.
        const newTurnOrder = activePlayers.length;

        // Insere Jogador
        await client.query(`
            INSERT INTO players (session_id, nickname, user_uid, capital, character_role, turn_order)
            VALUES ($1, $2, $3, 10, $4, $5)
        `, [session.id, playerName, userUid, assignedRole, newTurnOrder]);

        await client.query('COMMIT');
        return { success: true };
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}


async function startGame(gameCode) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const sessionRes = await client.query(`SELECT id, status FROM game_sessions WHERE game_code = $1`, [gameCode]);
        if (sessionRes.rowCount === 0) throw new Error("Não encontrado");
        const sessionId = sessionRes.rows[0].id;

        // 1. Descobrir quem é o primeiro jogador (turn_order = 0)
        const playerRes = await client.query(`
            SELECT character_role FROM players 
            WHERE session_id = $1 AND turn_order = 0
        `, [sessionId]);

        if (playerRes.rowCount === 0) throw new Error("Sem jogadores na partida.");
        const firstPlayerRole = playerRes.rows[0].character_role;

        // 2. Sortear carta ESPECÍFICA para esse papel
        const cardRes = await client.query(`
            SELECT id FROM decision_cards 
            WHERE assigned_role = $1 
            AND id NOT IN (
                SELECT card_id FROM session_decision_cards WHERE session_id = $2
            )
            ORDER BY RANDOM() LIMIT 1
        `, [firstPlayerRole, sessionId]); 

if (cardRes.rowCount === 0) throw new Error(`Sem cartas disponíveis (ou deck vazio) para o papel: ${firstPlayerRole}`);
        
        await client.query(`INSERT INTO session_decision_cards (session_id, card_id) VALUES ($1, $2)`, [sessionId, cardRes.rows[0].id]);
        
        // Atualiza status
        await client.query(`UPDATE game_sessions SET status = 'in_progress' WHERE id = $1`, [sessionId]);

        await client.query('COMMIT');
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
        const sessionRes = await client.query(`
            SELECT * FROM game_sessions WHERE game_code = $1
        `, [gameCode]);
        if (sessionRes.rowCount === 0) return null;
        const session = sessionRes.rows[0];

        const playersRes = await client.query(`
            SELECT id, nickname, character_role, capital, user_uid, turn_order
            FROM players WHERE session_id = $1 ORDER BY turn_order ASC
        `, [session.id]);

        // Busca carta atual E AS OPÇÕES
        const cardRes = await client.query(`
            SELECT sdc.id as session_card_id, dc.title, dc.dilemma, dc.options
            FROM session_decision_cards sdc
            JOIN decision_cards dc ON sdc.card_id = dc.id
            WHERE sdc.session_id = $1 AND sdc.is_resolved = FALSE
        `, [session.id]);

        //BUSCAR OS LOGS 
        const logsRes = await client.query(`
            SELECT id, turn, player_name as "playerName", player_role as "playerRole", decision_text as "decision", effects_text as "effects"
            FROM game_logs 
            WHERE session_id = $1 
            ORDER BY id DESC
        `, [session.id]);


        return {
            ...session,
            players: playersRes.rows,
            currentCard: cardRes.rows[0] || null,
            logs: logsRes.rows // <-- Adicione esta linha
        };
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

async function processDecision(gameCode, userUid, choiceIndex, difficulty) {
    // choiceIndex deve ser um inteiro: 0, 1, 2 ou 3
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');

        // 1. Validar Sessão e Turno
        const sessionRes = await client.query(`
            SELECT s.*, p.user_uid as current_player_uid, p.id as player_id, p.capital 
            FROM game_sessions s
            JOIN players p ON s.id = p.session_id AND p.turn_order = s.current_player_index
            WHERE s.game_code = $1
        `, [gameCode]);
        
        const state = sessionRes.rows[0];
        if (!state) throw new Error("Sessão inválida");
        if (state.status !== 'in_progress') throw new Error("Jogo não está ativo");
        if (state.current_player_uid !== userUid) throw new Error("Não é o seu turno!");

        // 2. Buscar Carta e Opções
        const cardRes = await client.query(`
            SELECT sdc.id as session_card_id, dc.options
            FROM session_decision_cards sdc
            JOIN decision_cards dc ON sdc.card_id = dc.id
            WHERE sdc.session_id = $1 AND sdc.is_resolved = FALSE
        `, [state.id]);
        
        const currentCard = cardRes.rows[0];
        if (!currentCard) throw new Error("Nenhuma carta ativa.");

        // 3. Validar Escolha
        const idx = parseInt(choiceIndex);
        if (isNaN(idx) || idx < 0 || idx >= currentCard.options.length) {
            throw new Error("Opção inválida.");
        }

        const selectedOption = currentCard.options[idx];
        const effects = selectedOption.effect; // JSON com os efeitos

        // 4. Aplicar Efeitos
        let updates = {
            economy: state.economy, education: state.education, wellbeing: state.wellbeing,
            popular_support: state.popular_support, hunger: state.hunger, military_religion: state.military_religion,
            board_position: state.board_position
        };
        let newPlayerCapital = state.capital;


        const consequences = Object.entries(effects).filter(([key]) => key !== 'capital' && key !== 'board_position');
        const totalConsequences = consequences.length;
        let positiveConsequences = 0;

        consequences.forEach(([key, value]) => {
            if (key === 'hunger' && value < 0) { // Fome diminuir é bom
                positiveConsequences++;
            } else if (key !== 'hunger' && value > 0) { // Outros indicadores aumentar é bom
                positiveConsequences++;
            }
        });

        // Lógica de progressão (Dificuldade e Tabuleiro)
        if (difficulty === 'hard') {
            const capitalChange = effects['capital'] || 0;
            const supportChange = effects['popular_support'] || 0;

            if (capitalChange > 0 && supportChange > 0) {
                updates.board_position += 2; 
            } else if (capitalChange > 0 || supportChange > 0) {
                updates.board_position += 1; 
            } else if (capitalChange < 0 && supportChange < 0) {
                updates.board_position = Math.max(0, updates.board_position - 1); 
            }
        } else {
            if (positiveConsequences === 0) {
                if (totalConsequences >= 2) {
                    updates.board_position = Math.max(0, updates.board_position - 1); 
                }
            } else {
                const ratio = positiveConsequences / totalConsequences;
                if (ratio > 0.5) {
                    updates.board_position += 2; 
                } else if (ratio >= 1/3) {
                    updates.board_position += 1; 
                }
            }
        }

        // Loop de aplicação com Clamping
        for (const [key, val] of Object.entries(effects)) {
            if (key === 'capital') {
                newPlayerCapital = Math.max(0, newPlayerCapital + val);
            } else if (key === 'board_position') {
                updates.board_position += val;
            } else if (updates.hasOwnProperty(key)) {
                updates[key] = Math.min(10, Math.max(0, updates[key] + val));
            }
        }

        const effectsString = Object.entries(effects).map(([key, value]) => `${key}: ${value > 0 ? '+' : ''}${value}`).join(', ');

        await client.query(`
            INSERT INTO game_logs (session_id, turn, player_name, player_role, decision_text, effects_text)
            SELECT $1, $2, p.nickname, p.character_role, $3, $4
            FROM players p
            WHERE p.id = $5
        `, [state.id, state.current_turn, selectedOption.text, effectsString, state.player_id]);

        // 5. Verificar Vitória/Derrota
        let gameStatus = 'in_progress';
        let endReason = null;

        const nonHungerIndicators = ['economy', 'education', 'wellbeing', 'popular_support', 'military_religion'];
        const anyIndicatorAtOrBelowZero = nonHungerIndicators.some(key => updates[key] <= 0);

        if (updates.hunger >= 10 || anyIndicatorAtOrBelowZero) {
            gameStatus = 'finished';
            endReason = 'collapsed';
        }

        if (updates.board_position >= 20) {
            gameStatus = 'finished';
            endReason = 'victory';
        }

        // 6. Atualizações no Banco
        await client.query(`
            UPDATE game_sessions SET 
                economy=$1, education=$2, wellbeing=$3, popular_support=$4, 
                hunger=$5, military_religion=$6, board_position=$7, 
                status=$8, end_reason=$9 
            WHERE id=$10
        `, [
            updates.economy, updates.education, updates.wellbeing, updates.popular_support, 
            updates.hunger, updates.military_religion, updates.board_position, 
            gameStatus, endReason, state.id
        ]);

        await client.query(`UPDATE players SET capital = $1 WHERE id = $2`, [newPlayerCapital, state.player_id]);

        await client.query(`
            UPDATE session_decision_cards SET is_resolved = TRUE, choice_made = $1 WHERE id = $2
        `, [idx, currentCard.session_card_id]);

        // 7. Próximo Turno
        if (gameStatus === 'in_progress') {
            
            // <--- MUDANÇA AQUI: Ignora o 'observador' na contagem total
            const countRes = await client.query(`
                SELECT COUNT(*) as c FROM players 
                WHERE session_id = $1 AND character_role != 'observador'
            `, [state.id]);
            
            const totalPlayers = parseInt(countRes.rows[0].c);
            
            // Calcula o próximo índice (0, 1, 2...)
            let nextIndex = (state.current_player_index + 1) % totalPlayers;
            
            // Rodada completou?
            if (nextIndex === 0) {
                await client.query(`UPDATE game_sessions SET current_turn = current_turn + 1 WHERE id = $1`, [state.id]);
            }
            await client.query(`UPDATE game_sessions SET current_player_index = $1 WHERE id = $2`, [nextIndex, state.id]);

            
            // 1. Descobrir o papel do PRÓXIMO jogador (O observador nunca será selecionado aqui pois turn_order dele é NULL)
            const nextPlayerRes = await client.query(`
                SELECT character_role FROM players 
                WHERE session_id = $1 AND turn_order = $2
            `, [state.id, nextIndex]);
            
            // Segurança extra caso algo dê errado
            if (nextPlayerRes.rowCount === 0) {
                throw new Error("Erro crítico: Próximo jogador não encontrado.");
            }

            const nextRole = nextPlayerRes.rows[0].character_role;

            // 2. Buscar carta para esse papel
            let newCardRes = await client.query(`
                SELECT id FROM decision_cards 
                WHERE assigned_role = $1 
                AND id NOT IN (
                    SELECT card_id FROM session_decision_cards WHERE session_id = $2
                )
                ORDER BY RANDOM() LIMIT 1
            `, [nextRole, state.id]);

            if (newCardRes.rowCount === 0) {
                await client.query(`DELETE FROM session_decision_cards WHERE session_id = $1 AND card_id IN (SELECT id FROM decision_cards WHERE assigned_role = $2)`, [state.id, nextRole]);

                newCardRes = await client.query(`
                SELECT id FROM decision_cards 
                WHERE assigned_role = $1 
                AND id NOT IN (
                    SELECT card_id FROM session_decision_cards WHERE session_id = $2
                )
                ORDER BY RANDOM() LIMIT 1
            `, [nextRole, state.id]);
            }

            await client.query(`INSERT INTO session_decision_cards (session_id, card_id) VALUES ($1, $2)`, [state.id, newCardRes.rows[0].id]);
        }

        await client.query('COMMIT');
        return { status: gameStatus, newStats: updates, playerCapital: newPlayerCapital };

    } catch (e) {
        await client.query('ROLLBACK');
        console.error(e);
        throw e;
    } finally {
        client.release();
    }
}


module.exports = {
    createGame,
    joinGame,
    getFullGameState,
    restartGame,
    startGame,
    processDecision
};
