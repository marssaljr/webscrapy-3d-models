# wow-model-scraper

Coletor local dos arquivos usados pelo Model Viewer da Wowhead/Zamimg: metadados JSON, modelos M2, skins, física e texturas WebP.

O projeto não usa dependências externas e requer Node.js 22.18 ou superior.

## Uso rápido

```bash
npm run scrape -- npc 137698 --expansion mists
npm run serve
```

O dashboard abre em `http://127.0.0.1:4317` e lê os dados de `./data`.

## Comandos

```bash
node src/cli.js scrape npc 137698 --expansion mists
node src/cli.js scrape npc 137698 1000-1005 --expansion mists --force
node src/cli.js scrape npc --file ids.txt --expansion mists
node src/cli.js meta npc 137698 --expansion mists
node src/cli.js list
node src/cli.js verify --checksums
node src/cli.js serve
node src/cli.js expansions
```

Tipos aceitos: `npc` (alias `creature`), `object` e `item`.

Principais opções do `scrape`:

| Opção | Efeito |
| --- | --- |
| `-e, --expansion <id>` | Expansão do Model Viewer (padrão: `mists`) |
| `-o, --out <dir>` | Pasta de dados (padrão: `data`) |
| `-F, --force` | Ignora o cache e baixa novamente |
| `--strict` | Falhas em texturas, skins ou física tornam o registro `failed` |
| `--no-model` | Não baixa M2, skins nem física |
| `--no-skins` | Não baixa arquivos `.skin` |
| `--no-phys` | Não baixa arquivos `.phys` |
| `--no-textures` | Não baixa texturas |
| `--concurrency <n>` | Registros processados em paralelo |
| `--asset-concurrency <n>` | Assets paralelos por registro |
| `--rate <n>` | Limite de requisições por segundo |
| `--retries <n>` | Tentativas em falhas temporárias |
| `--timeout <ms>` | Timeout por requisição |
| `--fail-fast` | Interrompe o lote na primeira falha |
| `-j, --json` | Saída JSON |

IDs podem ser separados por espaço ou vírgula, usar intervalos (`100-110`) e comentários com `#`. Use `--file -` para ler de stdin.

## Endpoints usados

Para a expansão `mists`:

```text
https://wow.zamimg.com/modelviewer/mists/meta/npc/{npcId}.json
https://wow.zamimg.com/modelviewer/mists/m2/{modelId}.m2
https://wow.zamimg.com/modelviewer/mists/skin/{skinId}.skin
https://wow.zamimg.com/modelviewer/mists/phys/{physId}.phys
https://wow.zamimg.com/modelviewer/mists/textures/{textureId}.webp
```

O meta fornece o `Model` e as texturas. Os IDs de skin e física são lidos dos chunks `SFID` e `PFID` do próprio M2, do mesmo modo que o viewer oficial faz.

## Saída

```text
data/
  <expansão>/
    meta/<tipo>/<id>.json
    catalog/<tipo>/<id>.json
    models/<modelId>.m2
    skins/<skinId>.skin
    phys/<physId>.phys
    textures/<textureId>.webp
```

O catálogo é o manifesto da coleta. Ele registra status, URLs de origem, tamanho, SHA-256, caminho local, erros e um resumo do meta.

Status possíveis:

- `complete`: todos os assets habilitados foram baixados ou reutilizados do cache.
- `partial`: o modelo principal foi obtido, mas alguma textura, skin ou física falhou.
- `failed`: o meta ou o modelo principal não pôde ser obtido.

## Comportamento

- Downloads são gravados primeiro em um arquivo temporário e movidos de forma atômica.
- Arquivos M2 e skins são validados pelo magic (`MD20`/`MD21` e `SKIN`); texturas são validadas como WebP.
- Requisições usam timeout, retry com backoff e limite de taxa.
- O meta e os assets já existentes são reutilizados por padrão. Use `--force` para substituir.
- NPCs com `Model: 0` e bloco `Character` usam montagem por raça/gênero. Nesses casos o registro recebe `CHARACTER_MODEL` e as texturas disponíveis ainda são baixadas.
- `Equipment` contém IDs de exibição de itens, não modelos ou texturas, e não é tratado como asset.

## API local

| Rota | Descrição |
| --- | --- |
| `GET /api/health` | Estado do servidor |
| `GET /api/expansions` | Expansões conhecidas |
| `GET /api/records` | Lista catálogos; aceita `expansion`, `kind`, `q` e `limit` |
| `GET /api/records/:expansion/:kind/:id` | Detalhe de um registro |
| `POST /api/scrape` | Coleta `{ expansion, kind, id, force?, strict? }` |
| `GET /data/*` | Arquivos locais coletados |

## Testes

```bash
npm test
```

A suíte usa um servidor HTTP local para simular os endpoints e cobre meta, M2, skins, física, texturas, cache, retry, validação, CLI e dashboard.

## Limitações

- Arquivos `.anim` não são baixados. Eles são carregados sob demanda pelo viewer e podem ser adicionados depois a partir dos IDs `AFID` do M2.
- M2 legado (`MD20`) não possui IDs de skin externos; apenas o modelo é salvo.
- Não há suporte a montagem de personagem por raça/gênero.

## Aviso

Os dados pertencem à Blizzard e à Wowhead/Zamimg. Use o projeto para fins pessoais, estudo ou protótipos, respeitando os termos dos serviços de origem. Não faça uso comercial dos assets.
