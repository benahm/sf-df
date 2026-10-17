# Stratégies metadata

## Principe

Chaque stratégie décide si elle supporte une opération metadata déjà résolue, puis produit soit :

- un delta package partiel ;
- un delta destructive partiel ;
- un delete manifest-only si le type ne supporte pas un destructive XML fin.

Le registre est défini dans [`src/delta/strategies/strategy-registry.ts`](../src/delta/strategies/strategy-registry.ts).

Le comportement attendu est :

- par défaut, toute metadata modifiée part dans le delta via `GenericFileStrategy` ;
- seulement les metadata avec des besoins particuliers ont une stratégie dédiée ;
- une stratégie spécialisée se branche sur le type metadata (`CustomLabels`, `Workflow`, `SharingRules`, `AssignmentRules`, `AutoResponseRules`, `MatchingRules`, `Profile`, `RecordType`, `Translations`) plutôt que sur un chemin figé.

## Stratégies dérivées du registre SDR

Fichiers : [`registry-collection-strategy.ts`](../src/delta/strategies/registry-collection-strategy.ts), [`registry-child-rules.ts`](../src/delta/strategies/registry-child-rules.ts)

Pour les types conteneurs dont les enfants sont décrits dans le registre `@salesforce/source-deploy-retrieve`
(`CustomLabels`, `Workflow`, `SharingRules`, `AssignmentRules`, `AutoResponseRules`, `MatchingRules`), les règles de diff
ne sont pas écrites à la main : chaque élément enfant (`labels`, `rules`, `sharingCriteriaRules`, `assignmentRule`...) est
indexé par son `uniqueIdElement` et associé à son type enfant.

- Le package contient un XML partiel avec uniquement les éléments ajoutés ou modifiés.
- Le destructive contient un XML partiel avec les éléments supprimés.
- `destructiveChanges.xml` liste les **types enfants** (`CustomLabel: LabelOne`, `WorkflowRule: Account.MyRule`,
  `SharingCriteriaRule: Account.MyRule`...) et jamais le conteneur entier.

Ajouter un autre type conteneur se fait en une ligne dans `StrategyRegistry` :
`new RegistryCollectionStrategy('<nom>', '<TypeMetadata>')`.

## Stratégies spécialisées

### `ProfileStrategy`

Fichier : [`src/delta/strategies/profile-strategy.ts`](../src/delta/strategies/profile-strategy.ts)

- Cible le type metadata `Profile`.
- Root XML : `Profile`.
- Utilise des clés métier stables par collection : `field`, `object`, `apexClass`, `layout + recordType`, etc.
- Réinjecte systématiquement quelques champs racine (`custom`, `description`, `userLicense`) pour garder un XML déployable.
- Ne produit pas de destructive XML partiel ; en suppression, on garde l'entrée manifest et on émet un warning.

### `TranslationsStrategy`

Fichier : [`src/delta/strategies/translations-strategy.ts`](../src/delta/strategies/translations-strategy.ts)

- Cible le type metadata `Translations`.
- Root XML : `Translations`.
- Diff par nom logique sur les sections comme `customLabels`, `fields`, `layouts`, `recordTypes`, `validationRules`.
- Ne produit pas de destructive XML partiel ; suppression en manifest-only.

### `RecordTypeStrategy`

Fichier : [`src/delta/strategies/record-type-strategy.ts`](../src/delta/strategies/record-type-strategy.ts)

- Cible le type metadata `RecordType`.
- Root XML : `RecordType`.
- Réinjecte les singletons requis (`fullName`, `active`, `label`, `businessProcess`, `compactLayoutAssignment`) pour garder un delta déployable.
- Laisse `diffCompositeXml` inclure automatiquement les autres champs modifiés hors collections déclarées.
- Ne produit pas de destructive XML partiel ; suppression en manifest-only.

## Fallback générique

### `GenericFileStrategy`

Fichier : [`src/delta/strategies/generic-file-strategy.ts`](../src/delta/strategies/generic-file-strategy.ts)

- Sert de dernière stratégie du registre.
- Réutilise le metadata déjà résolu par le moteur.
- Copie tous les fichiers contenus dans le composant résolu.
- Pour un delete, ajoute seulement l'entrée au manifest destructive.
- Exclut les dossiers `__tests__` des bundles LWC (tests Jest non déployables).

Ce fallback couvre aussi les bundles quand le resolver retourne un répertoire complet dans `contentRelativePaths`.

## Ajouter une nouvelle stratégie

1. Créer un fichier sous `src/delta/strategies/`.
2. Décider si le comportement générique suffit.
3. Si le metadata a un comportement particulier, implémenter une stratégie dédiée.
4. Si le metadata est XML composite, préférer hériter de `XmlCollectionDeltaStrategy`.
5. Déclarer les `metadataTypes` gérés par la stratégie.
6. Enregistrer la stratégie avant `GenericFileStrategy` dans `StrategyRegistry`.

Exemple de règle d'évolution :

- étape 1 : un nouveau metadata arrive, aucun code à écrire tant que la copie complète du composant suffit ;
- étape 2 : si ce metadata nécessite un diff partiel, on ajoute une stratégie spécialisée centrée sur ce type, sans casser le fallback générique.
