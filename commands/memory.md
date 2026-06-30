---
description: Interrupteur du moteur mémoire — /memory off | on | status
argument-hint: "[off|on|status]"
allowed-tools: Bash(node:*)
---

Interrupteur du moteur mémoire (kill-switch à chaud, fichier sentinelle `DISABLED`).

Exécute via l'outil Bash le script `scripts/memory-toggle.js` de ce plugin avec l'argument `$ARGUMENTS`
(vide → `status`), puis rapporte en UNE ligne l'état rendu.

⚠️ Limite plateforme (claude-code #9354) : `${CLAUDE_PLUGIN_ROOT}` n'est PAS substitué dans
les fichiers de commande markdown → ne pas s'y fier pour le chemin. Résous le script depuis le
répertoire d'installation du plugin (`~/.claude/plugins/cache/<marketplace>/memory-engine/<version>/scripts/memory-toggle.js`).
Si l'hôte n'expose pas `CLAUDE_PLUGIN_DATA` au shell, passe le data dir via `MEM_DATA_DIR=<dir>` pour viser le bon `DISABLED`.

`off` coupe toute injection/serveur/indexation dès le prochain message ; `on` rallume ; `status` ne change rien. Effet sans aucun restart.
