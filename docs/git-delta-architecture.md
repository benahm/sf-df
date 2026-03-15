# Architecture `sf df git delta`

## Vue d'ensemble

La commande [`src/commands/df/git/delta.ts`](/mnt/c/Users/abensaad/Documents/GitHub/sf-df/src/commands/df/git/delta.ts) orchestre un pipeline simple :

1. lire le diff git entre `--from` et `--to` ou le workspace courant ;
2. matérialiser les snapshots nécessaires ;
3. transformer chaque changement en opération `package` ou `destructive` ;
4. déléguer le traitement à une stratégie metadata ;
5. écrire les fichiers delta et générer les manifests.

Le coeur est dans [`src/delta/engine.ts`](/mnt/c/Users/abensaad/Documents/GitHub/sf-df/src/delta/engine.ts).

## Modules

### `git.ts`

- Exécute `git diff --name-status -M`.
- Normalise les statuts en `add`, `modify`, `delete`, `rename`.
- Travaille avec `core.quotePath=false` pour garder des chemins lisibles.

### `snapshot.ts`

- Crée un snapshot git temporaire avec `git archive` pour `--from` et éventuellement `--to`.
- Réutilise directement le workspace si `--to` n'est pas fourni.
- Nettoie les répertoires temporaires en fin de traitement.

### `metadata-resolver.ts`

- S'appuie sur `@salesforce/source-deploy-retrieve` pour résoudre type + fullName.
- Tente un fallback par convention de dossier si le resolver ne suffit pas.
- Gère explicitement les bundles `aura`, `lwc`, `experiences` et `staticresources`.

### `strategies/*`

- `StrategyRegistry` choisit la première stratégie compatible avec le chemin.
- Les stratégies XML spécialisées dérivent de `XmlCollectionDeltaStrategy`.
- `GenericFileStrategy` sert de fallback pour tous les autres metadata.

### `xml.ts`

- Parse le XML avec `fast-xml-parser`.
- Compare des collections par clé métier.
- Reconstruit un XML partiel stable à déployer ou supprimer.

### `manifest.ts`

- Génère `package.xml` et `destructiveChanges.xml` avec `xmlbuilder2`.
- Groupe les membres par type metadata.
- Trie types et membres pour une sortie stable.

## Flux de traitement

Pour un renommage, le moteur crée deux opérations :

- une opération `destructive` sur l'ancien chemin ;
- une opération `package` sur le nouveau chemin.

Chaque opération produit un `DeltaArtifacts` contenant au besoin :

- des copies de fichiers à écrire dans `package/` ;
- des fichiers XML textuels à écrire dans `package/` ou `destructive/` ;
- des entrées de manifest ;
- des warnings.

Le moteur déduplique les artefacts via `dedupeKey` pour éviter les doublons lorsqu'un même composant est touché plusieurs fois.

## Dépendances clés

- `@salesforce/source-deploy-retrieve` : résolution des metadata Salesforce.
- `fast-xml-parser` : parsing XML.
- `xmlbuilder2` : génération des manifests XML.
