# Stratégies metadata

## Principe

Chaque stratégie décide si elle supporte un chemin donné, puis produit soit :

- un delta package partiel ;
- un delta destructive partiel ;
- un delete manifest-only si le type ne supporte pas un destructive XML fin.

Le registre est défini dans [`src/delta/strategies/strategy-registry.ts`](/mnt/c/Users/abensaad/Documents/GitHub/sf-df/src/delta/strategies/strategy-registry.ts).

## Stratégies spécialisées

### `CustomLabelsStrategy`

Fichier : [`src/delta/strategies/custom-labels-strategy.ts`](/mnt/c/Users/abensaad/Documents/GitHub/sf-df/src/delta/strategies/custom-labels-strategy.ts)

- Cible `force-app/main/default/labels/`.
- Root XML : `CustomLabels`.
- Diff par `labels.fullName`.
- Supporte le destructive partiel.

### `WorkflowStrategy`

Fichier : [`src/delta/strategies/workflow-strategy.ts`](/mnt/c/Users/abensaad/Documents/GitHub/sf-df/src/delta/strategies/workflow-strategy.ts)

- Cible `force-app/main/default/workflows/`.
- Root XML : `Workflow`.
- Diff sur les collections comme `alerts`, `rules`, `tasks`, `fieldUpdates`.
- Supporte le destructive partiel quand une collection déclare `supportsDelete`.

### `ProfileStrategy`

Fichier : [`src/delta/strategies/profile-strategy.ts`](/mnt/c/Users/abensaad/Documents/GitHub/sf-df/src/delta/strategies/profile-strategy.ts)

- Cible `force-app/main/default/profiles/`.
- Root XML : `Profile`.
- Utilise des clés métier stables par collection : `field`, `object`, `apexClass`, `layout + recordType`, etc.
- Réinjecte systématiquement quelques champs racine (`custom`, `description`, `userLicense`) pour garder un XML déployable.
- Ne produit pas de destructive XML partiel ; en suppression, on garde l'entrée manifest et on émet un warning.

### `TranslationsStrategy`

Fichier : [`src/delta/strategies/translations-strategy.ts`](/mnt/c/Users/abensaad/Documents/GitHub/sf-df/src/delta/strategies/translations-strategy.ts)

- Cible `force-app/main/default/translations/`.
- Root XML : `Translations`.
- Diff par nom logique sur les sections comme `customLabels`, `fields`, `layouts`, `recordTypes`, `validationRules`.
- Ne produit pas de destructive XML partiel ; suppression en manifest-only.

## Fallback générique

### `GenericFileStrategy`

Fichier : [`src/delta/strategies/generic-file-strategy.ts`](/mnt/c/Users/abensaad/Documents/GitHub/sf-df/src/delta/strategies/generic-file-strategy.ts)

- Sert de dernière stratégie du registre.
- Résout le composant via `metadata-resolver.ts`.
- Copie tous les fichiers contenus dans le composant résolu.
- Pour un delete, ajoute seulement l'entrée au manifest destructive.

Ce fallback couvre aussi les bundles quand le resolver retourne un répertoire complet dans `contentRelativePaths`.

## Ajouter une nouvelle stratégie

1. Créer un fichier sous `src/delta/strategies/`.
2. Implémenter `supports(relativePath)` et `build(operation)`.
3. Si le metadata est XML composite, préférer hériter de `XmlCollectionDeltaStrategy`.
4. Enregistrer la stratégie avant `GenericFileStrategy` dans `StrategyRegistry`.
