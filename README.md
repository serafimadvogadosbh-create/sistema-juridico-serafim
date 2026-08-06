# Sistema Jurídico — Serafim Advogados

Aplicação web multiusuário com login individual e permissões por papel (sócio, advogado, estagiário). Sem dependências externas (usa apenas módulos nativos do Node.js e SQLite embutido), o que simplifica o deploy e reduz superfície de ataque.

## Contas de exemplo (TROCAR IMEDIATAMENTE após o primeiro acesso)

| Papel | E-mail | Senha |
|---|---|---|
| Sócio | serafimadvogados.bh@gmail.com | Trocar@123 |
| Advogado | camila@serafimadvogados.com.br | Trocar@123 |
| Estagiário | pedro@serafimadvogados.com.br | Trocar@123 |

Use o botão **Trocar senha** no menu lateral assim que entrar. Sócios podem criar novos usuários em **Usuários** e desativar acessos quando alguém sai do escritório.

## Regras de acesso por papel

- **Sócio**: acesso total, inclusive Financeiro, vê todos os processos e gerencia usuários.
- **Advogado**: vê e cria apenas os processos/clientes/tarefas dos quais é responsável. Sem acesso ao Financeiro.
- **Estagiário**: acesso somente leitura a processos e agenda; não cria processos nem clientes; sem Financeiro.

## Rodando localmente

```bash
npm start
```

Abre em `http://localhost:3000`. O banco SQLite é criado automaticamente em `data/app.db` no primeiro início, com os dados de exemplo acima.

Para recomeçar do zero (apaga todos os dados):

```bash
npm run seed
```

## Publicar online (Render)

Este projeto já inclui um `render.yaml` (Blueprint) pronto:

1. Suba este código para um repositório no GitHub (privado, recomendado — contém estrutura de dados sensíveis).
2. No Render, escolha **New > Blueprint** e aponte para o repositório.
3. O Render vai provisionar automaticamente o serviço web e o disco persistente para o banco de dados, conforme definido no `render.yaml`.
4. Após o primeiro deploy, acesse a URL gerada, faça login com as contas de exemplo acima e troque as senhas.

O plano usado no `render.yaml` é o **Starter** (pago) porque o disco persistente — necessário para o banco de dados não ser apagado a cada deploy — não está disponível no plano gratuito.

## Pontos de atenção antes de usar com dados reais de clientes

- **Backup**: o banco fica em um único arquivo SQLite no disco do Render. Configure rotina de backup (o Render permite snapshots do disco, ou você pode agendar exportações periódicas do arquivo).
- **HTTPS**: o Render fornece HTTPS automaticamente — não desative.
- **Senhas**: nunca reutilize as senhas de exemplo em produção. Cada usuário deve ter senha própria com no mínimo 8 caracteres (idealmente mais).
- **LGPD / sigilo profissional (OAB)**: este sistema não passou por auditoria de segurança formal. Antes de armazenar dados reais de clientes e processos, avalie com um profissional de segurança/DPO se os controles atuais atendem às exigências da LGPD e ao dever de sigilo do advogado.
- **Escala**: SQLite atende bem um escritório pequeno com poucos usuários simultâneos. Se o escritório crescer significativamente, considere migrar para PostgreSQL.
