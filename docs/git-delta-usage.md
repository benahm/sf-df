# Usage et sorties

## Commande

Commande exposée : [`src/commands/df/git/delta.ts`](/mnt/c/Users/abensaad/Documents/GitHub/sf-df/src/commands/df/git/delta.ts)

Exemples :

```bash
sf df git delta --from HEAD~1 --output-dir tmp/delta
sf df git delta --from main --to feature/my-branch --output-dir tmp/delta
```

## Flags

- `--from`, `-f` : ref git de départ.
- `--to`, `-t` : ref git de fin. Si absent, le workspace courant est utilisé.
- `--output-dir`, `-o` : dossier racine des artefacts générés.
- `--source-dir`, `-s` : dossier source metadata. Défaut : `force-app/main/default`.

## Structure de sortie

Le moteur écrit :

```text
<output-dir>/
  package/
    package.xml
    force-app/main/default/...
  destructive/
    destructiveChanges.xml
    force-app/main/default/...    # seulement pour les metadata qui génèrent un destructive XML partiel
```

Selon le type metadata :

- metadata générique : copie des fichiers sources dans `package/` ;
- metadata XML composite : génération d'un XML partiel dans `package/` ;
- suppressions partielles supportées : XML partiel dans `destructive/` ;
- suppressions non supportées : manifest-only + warning.

## Résultat JSON

La commande renvoie un objet `DeltaResult` contenant notamment :

- `from`, `to`, `sourceDir`
- `packageDir`, `destructiveDir`
- `packageManifestPath`, `destructiveManifestPath`
- `processedChanges`
- `countsByStatus`
- `countsByStrategy`
- `warnings`

## Limites connues

- Les stratégies spécialisées matchent aujourd'hui des chemins codés en dur sous `force-app/main/default/...`.
  `--source-dir` est bien accepté par la commande et utilisé par le moteur, mais les matchers spécialisés restent alignés sur ce layout V1.
- `Profile` et `Translations` ne produisent pas de destructive XML partiel.
- Le destructive générique repose surtout sur le manifest, pas sur une recopie complète des fichiers supprimés.
- La qualité du fallback dépend de la capacité du resolver SDR ou du fallback par convention à identifier le type metadata.
