# Exportação em pasta (uma pasta por reunião)

Com uma pasta de backup escolhida em **Ajustes › Backup e sincronização** e o ajuste
**"Gravar também uma pasta legível por reunião"** ligado, o Escribanote grava, para cada reunião
encerrada, uma pasta dentro de `Reuniões/`:

```
<pasta de backup>/Escribanote/
├── 2026-10-26_1430_<id>.json          ← backup (formato de restauração, não mexa)
├── escribanote-ajustes.json
└── Reuniões/
    └── 2026-10-26 1430 Planejamento Q4/
        ├── transcricao.md             ← Markdown com ata, destaques, notas, capítulos e transcrição
        ├── reuniao.json               ← manifesto (abaixo)
        ├── outros.webm                ← áudio dos outros participantes (se o áudio foi guardado)
        └── microfone.webm             ← seu microfone (se o áudio foi guardado)
```

- A pasta é regravada sempre que a reunião muda (nota nova, ata gerada, correção manual, renome).
  Renomear a reunião renomeia a pasta; apagar a reunião apaga a pasta.
- Reuniões em andamento não são exportadas; a primeira gravação acontece até 15 s depois do encerramento.
- Arquivos importados aparecem como `gravacao.<extensão original>`.
- Nada é enviado a lugar nenhum: a pasta é a que você escolheu (pode ser OneDrive, Google Drive ou rede).

## `reuniao.json`

```json
{
  "app": "escribanote",
  "versao": 1,
  "escribanote": "3.5.0",
  "id": "meet-abc-defg-hij-2026-10-26",
  "titulo": "Planejamento Q4",
  "plataforma": "meet",
  "inicio": "2026-10-26T17:30:00.000Z",
  "fim": "2026-10-26T18:25:12.000Z",
  "duracaoSegundos": 3312,
  "idioma": "pt",
  "participantes": ["Ana Lima", "Bruno Souza"],
  "falas": 412,
  "trechosWhisper": 0,
  "modeloWhisper": null,
  "capitulos": [{ "inicio": "00:00:00", "titulo": "Abertura e pauta" }],
  "temAta": true,
  "audio": ["outros.webm", "microfone.webm"],
  "exportadoEm": "2026-10-26T18:25:40.000Z"
}
```

`plataforma`: `meet`, `teams`, `zoom`, `slack`, `desktop` (gravador do computador) ou `import`.

## `transcricao.md`

Mesmo formato da exportação em Markdown do painel: título, plataforma, data, participantes;
seções **Ata**, **Destaques**, **Notas** e **Capítulos** quando existem; e **Transcrição** com um
parágrafo por fala (`**Nome** · `hh:mm:ss``), horário no início de cada parágrafo longo e títulos
`### n. Capítulo` no ponto em que cada capítulo começa.

## Usar com scripts

Observe a pasta `Reuniões/` (por exemplo, com um watcher de arquivos ou uma tarefa agendada) e
leia `reuniao.json` para decidir o que fazer: arquivar no Obsidian, enviar para um sistema interno,
gerar um resumo com outra ferramenta. Considere a pasta pronta quando `reuniao.json` existir e
`fim` não for nulo. Grave o que você produzir fora da pasta `Escribanote/`, para não ser confundido
com backup.
