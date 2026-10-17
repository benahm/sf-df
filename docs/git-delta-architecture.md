# Architecture `sf df git delta`

## Vue d'ensemble

La commande [`src/commands/df/git/delta.ts`](../src/commands/df/git/delta.ts) orchestre un pipeline simple :

1. lire le diff git entre `--from` et `--to` ou le workspace courant ;
2. matérialiser les snapshots nécessaires ;
3. transformer chaque changement en opération `package` ou `destructive` ;
4. résoudre une fois le metadata concerné ;
5. déléguer le traitement à une stratégie metadata ;
6. écrire les fichiers delta et générer les manifests.

Le coeur est dans [`src/delta/engine.ts`](../src/delta/engine.ts).

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
- Fournit un contexte réutilisable par le registre et les stratégies pour éviter les résolutions dupliquées.

### `strategies/*`

- `StrategyRegistry` choisit d'abord une stratégie spécialisée à partir du type metadata résolu.
- `GenericFileStrategy` est le fallback explicite si aucune stratégie spécifique ne s'applique.
- Les stratégies XML spécialisées dérivent de `XmlCollectionDeltaStrategy`.
- Les stratégies ne sont plus couplées à un `sourceDir` codé en dur.

### `xml.ts`

- Parse le XML avec `fast-xml-parser`.
- Compare des collections par clé métier.
- Reconstruit un XML partiel stable à déployer ou supprimer.

### `manifest.ts`

- Génère `package.xml` et `destructiveChanges.xml` via `ComponentSet.getPackageXml()` de SDR (même format que `sf`).
- Utilise `sourceApiVersion` de `sfdx-project.json`, sinon la version d'API embarquée par SDR.

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

## Contrat d'extension

Le pipeline suit désormais deux niveaux simples :

1. comportement générique : si un metadata est modifié, il est inclus dans le delta via `GenericFileStrategy` ;
2. comportement spécifique : un metadata peut surcharger ce comportement via une stratégie dédiée.

Concrètement, le moteur construit un `ResolvedOperation` avec :

- l'opération git normalisée ;
- le metadata résolu (`resolvedMetadata`) ;
- l'entrée de manifest résolue (`manifestEntry`).

Le registre choisit ensuite :

- une stratégie spécifique si `supports(ResolvedOperation)` retourne `true` ;
- sinon le fallback générique.

Ce modèle rend l'ajout d'un nouveau metadata spécifique évolutif :

1. rien faire si le comportement générique suffit ;
2. créer une stratégie dédiée si le metadata a des règles de delta particulières ;
3. l'enregistrer dans `StrategyRegistry` avant le fallback générique.

## Dépendances clés

- `@salesforce/source-deploy-retrieve` : résolution des metadata Salesforce, registre des types enfants, génération des manifests.
- `fast-xml-parser` : parsing XML.
