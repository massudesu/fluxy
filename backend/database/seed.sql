-- ============================================================
-- Fluxy — dados de exemplo (opcional)
-- Rodar com: npm run db:seed
-- Cria uma empresa ficticia "Padaria Sao Jose" com login de teste:
--   e-mail: mariana@padariasaojose.com.br
--   senha : Senha1234
-- Use apenas no seu computador: nunca rode em um banco de producao, porque
-- a senha desta conta e publica.
-- ============================================================

INSERT INTO empresa (id, razao_social, nome_fantasia, cnpj, segmento, telefone, email, endereco, cidade, estado, cep)
VALUES
    ('11111111-1111-1111-1111-111111111111', 'Padaria Sao Jose Ltda', 'Padaria Sao Jose', '12.345.678/0001-90',
     'Alimenticio', '(11) 4002-8922', 'contato@padariasaojose.com.br', 'Rua das Flores, 120', 'Sao Paulo', 'SP', '01310-100')
ON CONFLICT (id) DO NOTHING;

INSERT INTO configuracao_empresa (empresa_id, moeda, tema, notificar_contas, notificar_eventos)
VALUES ('11111111-1111-1111-1111-111111111111', 'BRL', 'claro', TRUE, TRUE)
ON CONFLICT (empresa_id) DO NOTHING;

INSERT INTO empresa_modulo (empresa_id, modulo_id, ativo)
SELECT '11111111-1111-1111-1111-111111111111', id, TRUE FROM modulo_sistema
ON CONFLICT (empresa_id, modulo_id) DO NOTHING;

-- Os hashes abaixo sao gerados com o mesmo scrypt que o backend usa
-- (backend/src/lib/security.js), nao com o crypt()/bcrypt do pgcrypto -
-- por isso os valores vem prontos em vez de usar crypt() aqui.
-- Senha de teste: Senha1234
INSERT INTO usuario (id, empresa_id, nome, email, senha_hash, telefone, cpf, papel)
VALUES
    ('aaaaaaaa-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111',
     'Mariana Souza', 'mariana@padariasaojose.com.br',
     '4f6c3ccf1aaa2f29699cf9572e05ed60:3d1d2cfcd2b0f8de0fd741a08e972c65c1aec6779dab1eaded7a86de51a5001f986d7644212e1b9084e017c3fceffd922a769bd241ac39c31641813e0a8f3337',
     '(11) 98888-1234', '123.456.789-00',
     'admin')
ON CONFLICT (email) DO NOTHING;

INSERT INTO categoria (empresa_id, nome, tipo) VALUES
    ('11111111-1111-1111-1111-111111111111', 'Vendas no balcao', 'receita'),
    ('11111111-1111-1111-1111-111111111111', 'Encomendas', 'receita'),
    ('11111111-1111-1111-1111-111111111111', 'Fornecedores', 'despesa'),
    ('11111111-1111-1111-1111-111111111111', 'Aluguel', 'despesa')
ON CONFLICT (empresa_id, nome, tipo) DO NOTHING;

-- Os dados de negocio so entram na primeira execucao (rodar o seed de novo nao
-- duplica nada) e todas as buscas ficam restritas a empresa de exemplo.
DO $$
DECLARE
    emp CONSTANT UUID := '11111111-1111-1111-1111-111111111111';
BEGIN
    IF EXISTS (SELECT 1 FROM cliente WHERE empresa_id = emp) THEN
        RETURN;
    END IF;

    INSERT INTO cliente (empresa_id, nome, email, telefone, observacoes) VALUES
        (emp, 'Joao Almeida', 'joao.almeida@email.com', '(11) 91234-5678', NULL),
        (emp, 'Restaurante Sabor Caseiro', 'compras@saborcaseiro.com.br', '(11) 3344-5566', 'Cliente fixo, pedidos semanais');

    INSERT INTO fornecedor (empresa_id, nome, documento, telefone, email, cidade, estado, categoria_fornecida) VALUES
        (emp, 'Distribuidora Farinha Boa', '33.444.555/0001-66', '(11) 4455-6677', 'vendas@farinhaboa.com.br', 'Sao Paulo', 'SP', 'Insumos de padaria'),
        (emp, 'Laticinios Vale Verde', '44.555.666/0001-77', '(11) 4488-9900', 'contato@valeverde.com.br', 'Campinas', 'SP', 'Laticinios');

    INSERT INTO produto (empresa_id, fornecedor_id, codigo, codigo_barras, nome, categoria, quantidade, quantidade_minima, preco_custo, preco_venda)
    VALUES
        (emp, (SELECT id FROM fornecedor WHERE empresa_id = emp AND documento = '33.444.555/0001-66'),
         'FAR-001', '7891234500012', 'Farinha de trigo 25kg', 'Insumos', 40, 10, 85.00, 0.00),
        (emp, (SELECT id FROM fornecedor WHERE empresa_id = emp AND documento = '44.555.666/0001-77'),
         'MAN-002', '7891234500029', 'Manteiga sem sal 500g', 'Laticinios', 8, 12, 9.50, 14.90)
    ON CONFLICT (empresa_id, codigo) DO NOTHING;

    INSERT INTO movimentacao_estoque (empresa_id, produto_id, produto_nome, tipo, quantidade, data_movimentacao, observacao) VALUES
        (emp, (SELECT id FROM produto WHERE empresa_id = emp AND codigo = 'FAR-001'), 'Farinha de trigo 25kg', 'entrada', 50, CURRENT_DATE - 20, 'Compra mensal'),
        (emp, (SELECT id FROM produto WHERE empresa_id = emp AND codigo = 'FAR-001'), 'Farinha de trigo 25kg', 'saida', 10, CURRENT_DATE - 5, 'Consumo de producao'),
        (emp, (SELECT id FROM produto WHERE empresa_id = emp AND codigo = 'MAN-002'), 'Manteiga sem sal 500g', 'entrada', 20, CURRENT_DATE - 15, 'Compra semanal'),
        (emp, (SELECT id FROM produto WHERE empresa_id = emp AND codigo = 'MAN-002'), 'Manteiga sem sal 500g', 'saida', 12, CURRENT_DATE - 2, 'Consumo de producao');

    INSERT INTO transacao (empresa_id, categoria_id, cliente_id, tipo, descricao, valor, data_transacao)
    VALUES
        (emp,
         (SELECT id FROM categoria WHERE empresa_id = emp AND nome = 'Vendas no balcao' AND tipo = 'receita'),
         (SELECT id FROM cliente WHERE empresa_id = emp AND nome = 'Joao Almeida'),
         'entrada', 'Venda de paes e salgados', 245.50, CURRENT_DATE - 3),
        (emp,
         (SELECT id FROM categoria WHERE empresa_id = emp AND nome = 'Encomendas' AND tipo = 'receita'),
         (SELECT id FROM cliente WHERE empresa_id = emp AND nome = 'Restaurante Sabor Caseiro'),
         'entrada', 'Encomenda de 20 bolos', 890.00, CURRENT_DATE - 1),
        (emp,
         (SELECT id FROM categoria WHERE empresa_id = emp AND nome = 'Fornecedores' AND tipo = 'despesa'), NULL,
         'saida', 'Compra de farinha de trigo', 340.00, CURRENT_DATE - 20),
        (emp,
         (SELECT id FROM categoria WHERE empresa_id = emp AND nome = 'Aluguel' AND tipo = 'despesa'), NULL,
         'saida', 'Aluguel do imovel - mes vigente', 3200.00, CURRENT_DATE - 8);

    INSERT INTO conta (empresa_id, tipo, descricao, valor, vencimento, status)
    VALUES
        (emp, 'receber', 'Encomenda de casamento - 2a parcela', 650.00, CURRENT_DATE + 10, 'pendente'),
        (emp, 'pagar', 'Laticinios - fatura mensal', 410.00, CURRENT_DATE + 5, 'pendente');

    INSERT INTO servico (empresa_id, cliente_id, descricao, valor, data_servico)
    VALUES
        (emp, (SELECT id FROM cliente WHERE empresa_id = emp AND nome = 'Restaurante Sabor Caseiro'),
         'Montagem de mesa de doces para evento', 480.00, CURRENT_DATE - 4);

    INSERT INTO evento_agenda (empresa_id, titulo, tipo, data_evento, horario, descricao)
    VALUES
        (emp, 'Entrega - Restaurante Sabor Caseiro', 'entrega', CURRENT_DATE + 2, '09:00', 'Levar encomenda de bolos'),
        (emp, 'Reuniao com fornecedor de laticinios', 'fornecedor', CURRENT_DATE + 6, '14:30', NULL);
END $$;
