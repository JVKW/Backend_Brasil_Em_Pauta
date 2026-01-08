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
async function createGame(userUid, playerName, difficulty = 'easy', isObserver = false) {
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
            INSERT INTO game_sessions (game_code, status, current_turn, current_player_index, creator_user_uid, difficulty)
            VALUES ($1, 'waiting', 1, 0, $2, $3)
            RETURNING id
        `, [gameCode, userUid, difficulty]);
        const sessionId = sessionRes.rows[0].id;
        
        // Define os valores iniciais dos indicadores com base na dificuldade
        const initialIndicatorValue = difficulty === 'hard' ? 3 : 5;

        // Cria o estado inicial da nação
        await client.query(`
            INSERT INTO nation_states (game_session_id, economy, education, wellbeing, popular_support, hunger, military_religion, board_position)
            VALUES ($1, $2, $2, $2, $2, $2, $2, 0)
        `, [sessionId, initialIndicatorValue]);


        if (userUid && playerName) {
            if (isObserver) {
                // --- CAMINHO DO OBSERVADOR ---
                // Registra na tabela, mas sem capital, sem turno e role fixa
                await client.query(`
                    INSERT INTO players (session_id, nickname, user_uid, capital, character_role, turn_order)
                    VALUES ($1, $2, $3, 0, 'Observador', NULL)
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
        const activePlayers = playersRes.rows.filter(p => p.character_role !== 'Observador');
        
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

        const sessionRes = await client.query(`SELECT id, status FROM game_sessions WHERE game_code = $1 FOR UPDATE`, [gameCode]);
        if (sessionRes.rowCount === 0) throw new Error("Não encontrado");
        const sessionId = sessionRes.rows[0].id;
        
        // LÓGICA DO OPORTUNISTA: 25% de chance de um jogador virar oportunista
        const activePlayersRes = await client.query(`
            SELECT id FROM players WHERE session_id = $1 AND character_role != 'Observador'
        `, [sessionId]);

        if (Math.random() < 0.25 && activePlayersRes.rowCount > 0) {
            const players = activePlayersRes.rows;
            const chosenOne = players[Math.floor(Math.random() * players.length)];
            await client.query(`UPDATE players SET character_role = 'Oportunista' WHERE id = $1`, [chosenOne.id]);
        }

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
            WHERE (assigned_role = $1 OR assigned_role = 'Cidadão')
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
        // Busca a sessão e o estado da nação em uma única consulta
        const sessionRes = await client.query(`
            SELECT 
                s.id, s.game_code, s.status, s.creator_user_uid, s.current_turn, 
                s.current_player_index, s.end_reason, s.difficulty, s.game_over_message,
                ns.economy, ns.education, ns.wellbeing, ns.popular_support, 
                ns.hunger, ns.military_religion, ns.board_position
            FROM game_sessions s
            LEFT JOIN nation_states ns ON s.id = ns.game_session_id
            WHERE s.game_code = $1
        `, [gameCode]);

        if (sessionRes.rowCount === 0) return null;
        const sessionWithState = sessionRes.rows[0];

        const playersRes = await client.query(`
            SELECT id, nickname, character_role, capital, user_uid, turn_order
            FROM players WHERE session_id = $1 ORDER BY turn_order ASC
        `, [sessionWithState.id]);

        // Busca carta atual E AS OPÇÕES
        const cardRes = await client.query(`
            SELECT sdc.id as session_card_id, dc.title, dc.dilemma, dc.options
            FROM session_decision_cards sdc
            JOIN decision_cards dc ON sdc.card_id = dc.id
            WHERE sdc.session_id = $1 AND sdc.is_resolved = FALSE
            ORDER BY sdc.id DESC LIMIT 1
        `, [sessionWithState.id]);

        //BUSCAR OS LOGS 
        const logsRes = await client.query(`
            SELECT id, turn, player_name as "playerName", player_role as "playerRole", decision_text as "decision", effects_text as "effects"
            FROM game_logs 
            WHERE session_id = $1 
            ORDER BY id DESC
        `, [sessionWithState.id]);

        return {
            ...sessionWithState,
            players: playersRes.rows,
            currentCard: cardRes.rows[0] || null,
            logs: logsRes.rows
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
        const sessionAndNationRes = await client.query(`
            SELECT 
                s.id, s.status, s.current_turn, s.current_player_index, s.game_over_message,
                p.user_uid as current_player_uid, p.id as player_id, p.capital, p.nickname, p.character_role,
                ns.economy, ns.education, ns.wellbeing, ns.popular_support, 
                ns.hunger, ns.military_religion, ns.board_position
            FROM game_sessions s
            JOIN players p ON s.id = p.session_id AND p.turn_order = s.current_player_index
            JOIN nation_states ns ON s.id = ns.game_session_id
            WHERE s.game_code = $1 FOR UPDATE
        `, [gameCode]);
        
        const state = sessionAndNationRes.rows[0];
        if (!state) throw new Error("Sessão ou estado da nação inválido.");
        if (state.status !== 'in_progress') throw new Error("Jogo não está ativo");
        if (state.current_player_uid !== userUid) throw new Error("Não é o seu turno!");

        // 2. Buscar Carta e Opções
        const cardRes = await client.query(`
            SELECT sdc.id as session_card_id, dc.options
            FROM session_decision_cards sdc
            JOIN decision_cards dc ON sdc.card_id = dc.id
            WHERE sdc.session_id = $1 AND sdc.is_resolved = FALSE
            ORDER BY sdc.id DESC LIMIT 1
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

        // Loop de aplicação com Clamping
        for (const [key, val] of Object.entries(effects)) {
            if (key === 'capital') {
                newPlayerCapital = Math.max(0, newPlayerCapital + val);
            } else if (key === 'board_position') {
                // Este efeito é tratado separadamente abaixo para consolidar lógica
            } else if (updates.hasOwnProperty(key)) {
                updates[key] = Math.min(10, Math.max(0, updates[key] + val));
            }
        }
        
        const consequences = Object.entries(effects).filter(([key]) => key !== 'capital' && key !== 'board_position');
        const totalConsequences = consequences.length;
        let positiveConsequences = 0;

        consequences.forEach(([key, value]) => {
            if (key === 'hunger' && value < 0) {
                positiveConsequences++;
            } else if (key !== 'hunger' && value > 0) {
                positiveConsequences++;
            }
        });
        
        // Lógica de progressão no tabuleiro
        let boardMovement = effects['board_position'] || 0; // Começa com o movimento base da carta
        if (difficulty === 'hard') {
            const capitalChange = effects['capital'] || 0;
            const supportChange = effects['popular_support'] || 0;

            if (capitalChange > 0 && supportChange > 0) boardMovement += 2; 
            else if (capitalChange > 0 || supportChange > 0) boardMovement += 1;
            else if (capitalChange < 0 && supportChange < 0) boardMovement -= 1;
        } else {
             const ratio = totalConsequences > 0 ? positiveConsequences / totalConsequences : 0;
             if (ratio > 0.5) boardMovement += 2;
             else if (ratio >= 1/3) boardMovement += 1;
             else if (ratio === 0 && totalConsequences > 1) boardMovement -= 1;
        }
        updates.board_position = Math.max(0, updates.board_position + boardMovement);


        const effectsString = Object.entries(effects).map(([key, value]) => `${key}: ${value > 0 ? '+' : ''}${value}`).join(', ');

        await client.query(`
            INSERT INTO game_logs (session_id, turn, player_name, player_role, decision_text, effects_text)
            VALUES ($1, $2, $3, $4, $5, $6)
        `, [state.id, state.current_turn, state.nickname, state.character_role, selectedOption.text, effectsString]);

        // 5. Verificar Vitória/Derrota
        let gameStatus = 'in_progress';
        let gameOverMessage = null;

        if (gameStatus === 'in_progress') {
            const nonHungerIndicators = ['economy', 'education', 'wellbeing', 'popular_support', 'military_religion'];
            const anyIndicatorAtOrBelowZero = nonHungerIndicators.some(key => updates[key] <= 0);

            if (updates.hunger >= 10 || anyIndicatorAtOrBelowZero) {
                gameStatus = 'finished';
                gameOverMessage = "Colapso! Um indicador essencial chegou a zero ou a fome atingiu níveis insustentáveis. A nação entrou em ruínas. Todos perdem.";
            }
        }
        
        // Verifica vitória coletiva se o jogo ainda estiver em andamento
        if (gameStatus === 'in_progress' && updates.board_position >= 25) { // Supondo que 25 é o final
             const collectiveWin = ['economy', 'education', 'wellbeing', 'popular_support', 'military_religion'].every(key => updates[key] > 7);
             if(collectiveWin) {
                gameStatus = 'finished';
                gameOverMessage = "Vitória Coletiva! A nação prosperou e alcançou a Justiça Social!";
             }
        }
        
        // Verifica vitória do Oportunista se o jogo ainda estiver em andamento
        if (gameStatus === 'in_progress') {
            const opportunist = await client.query(`SELECT id, capital, nickname FROM players WHERE session_id = $1 AND character_role = 'Oportunista'`, [state.id]);
            if(opportunist.rowCount > 0) {
                const opportunistPlayer = opportunist.rows[0];
                // Verifica se o jogador que tomou a decisão é o oportunista para usar o capital atualizado
                const capitalToCheck = opportunistPlayer.id === state.player_id ? newPlayerCapital : opportunistPlayer.capital;

                if(capitalToCheck >= 100 && updates.education < 3) {
                    gameStatus = 'finished';
                    gameOverMessage = `Vitória do Oportunista! Com o povo alienado, ${opportunistPlayer.nickname} acumulou poder e consolidou seus interesses.`;
                }
            }
        }
        

        // 6. Atualizações no Banco
        await client.query(`
            UPDATE nation_states SET 
                economy=$1, education=$2, wellbeing=$3, popular_support=$4, 
                hunger=$5, military_religion=$6, board_position=$7
            WHERE game_session_id=$8
        `, [
            updates.economy, updates.education, updates.wellbeing, updates.popular_support, 
            updates.hunger, updates.military_religion, updates.board_position, state.id
        ]);
        
        await client.query(`
            UPDATE game_sessions SET status=$1, game_over_message=$2 WHERE id=$3
        `,[gameStatus, gameOverMessage, state.id]);


        await client.query(`UPDATE players SET capital = $1 WHERE id = $2`, [newPlayerCapital, state.player_id]);

        await client.query(`
            UPDATE session_decision_cards SET is_resolved = TRUE, choice_made = $1 WHERE id = $2
        `, [idx, currentCard.session_card_id]);

        // 7. Próximo Turno
        if (gameStatus === 'in_progress') {
            
            const countRes = await client.query(`
                SELECT COUNT(*) as c FROM players 
                WHERE session_id = $1 AND character_role != 'Observador'
            `, [state.id]);
            
            const totalPlayers = parseInt(countRes.rows[0].c);
            
            if (totalPlayers > 0) {
                let nextIndex = (state.current_player_index + 1) % totalPlayers;
                
                if (nextIndex === 0) {
                    await client.query(`UPDATE game_sessions SET current_turn = current_turn + 1 WHERE id = $1`, [state.id]);
                }
                await client.query(`UPDATE game_sessions SET current_player_index = $1 WHERE id = $2`, [nextIndex, state.id]);

                const nextPlayerRes = await client.query(`
                    SELECT character_role FROM players 
                    WHERE session_id = $1 AND turn_order = $2
                `, [state.id, nextIndex]);
                
                if (nextPlayerRes.rowCount === 0) throw new Error("Erro crítico: Próximo jogador não encontrado.");

                const nextRole = nextPlayerRes.rows[0].character_role;

                let newCardRes = await client.query(`
                    SELECT id FROM decision_cards 
                    WHERE (assigned_role = $1 OR assigned_role IS NULL)
                    AND id NOT IN (
                        SELECT card_id FROM session_decision_cards WHERE session_id = $2
                    )
                    ORDER BY RANDOM() LIMIT 1
                `, [nextRole, state.id]);

                if (newCardRes.rowCount === 0) {
                     // Deck do papel específico esgotou, busca carta genérica
                     newCardRes = await client.query(`
                        SELECT id FROM decision_cards 
                        WHERE assigned_role IS NULL
                        AND id NOT IN (
                            SELECT card_id FROM session_decision_cards WHERE session_id = $1
                        )
                        ORDER BY RANDOM() LIMIT 1
                    `, [state.id]);
                    if(newCardRes.rowCount === 0) {
                        // Se até as genéricas acabaram, reseta o deck do papel
                        await client.query(`DELETE FROM session_decision_cards WHERE session_id = $1 AND card_id IN (SELECT id FROM decision_cards WHERE assigned_role = $2)`, [state.id, nextRole]);
                         newCardRes = await client.query(`
                            SELECT id FROM decision_cards 
                            WHERE assigned_role = $1 ORDER BY RANDOM() LIMIT 1`, [nextRole]
                         );
                    }
                }
                
                if (newCardRes.rowCount > 0) {
                    await client.query(`INSERT INTO session_decision_cards (session_id, card_id) VALUES ($1, $2)`, [state.id, newCardRes.rows[0].id]);
                } else {
                     console.error(`Nenhuma carta encontrada para o papel ${nextRole} ou genérica, mesmo após reset.`);
                }
            }
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
