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
- une stratégie spécialisée se branche sur le type metadata (`CustomLabels`, `Workflow`, `SharingRules`, `AssignmentRules`, `AutoResponseRules`, `MatchingRules`, `Profile`, `RecordType`, `Translations`, `Flow`) plutôt que sur un chemin figé ;
- le delta reste minimal : seul ce qui a changé est déployé, plus les fichiers que Salesforce exige (ex. le `.objectTranslation` parent d'une traduction de champ modifiée).

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
- Un élément retiré du fichier (`fieldPermissions`, `classAccesses`...) ne produit rien à déployer mais un warning
  (`warnOnRemovedItems`) qui nomme les dix premiers éléments retirés : le déploiement d'un profil ne révoque jamais ce
  que le XML ne cite pas (vérifié en sandbox). Pour révoquer un accès, il faut le garder dans le fichier à `false`.

### `TranslationsStrategy`

Fichier : [`src/delta/strategies/translations-strategy.ts`](../src/delta/strategies/translations-strategy.ts)

- Cible le type metadata `Translations`.
- Root XML : `Translations`.
- Diff par nom logique sur les sections comme `customLabels`, `fields`, `layouts`, `recordTypes`, `validationRules`.
- N'apparaît jamais dans `destructiveChanges.xml` (`neverDelete`) : les traductions disparaissent avec les composants traduits.

### `RecordTypeStrategy`

Fichier : [`src/delta/strategies/record-type-strategy.ts`](../src/delta/strategies/record-type-strategy.ts)

- Cible le type metadata `RecordType`.
- Root XML : `RecordType`.
- Réinjecte les singletons requis (`fullName`, `active`, `label`, `businessProcess`, `compactLayoutAssignment`) pour garder un delta déployable.
- Laisse `diffCompositeXml` inclure automatiquement les autres champs modifiés hors collections déclarées.
- Suppression : désactivation (`active=false`), voir les règles vérifiées en sandbox ci-dessous.

### `FlowStrategy`

Fichier : [`src/delta/strategies/flow-strategy.ts`](../src/delta/strategies/flow-strategy.ts)

- Ajout / modification : copie complète via `GenericFileStrategy`.
- Suppression : un Flow ne peut pas être supprimé par son nom (`insufficient access rights on cross-reference id`),
  seulement par version (`MonFlow-3`), et les versions n'existent que dans l'org. Le delta déploie donc un
  `FlowDefinition` avec `activeVersionNumber=0` (désactivation) et émet un warning pour la suppression manuelle.

## Règles de suppression vérifiées en sandbox

Ces règles viennent de déploiements réels en sandbox et en scratch org (scénario rejouable : `test/e2e-org/metadata-lifecycle.org.e2e.test.ts`).
Chacune est couverte par `test/delta/sandbox-findings.test.ts`.

| Situation | Ce que Salesforce fait / refuse | Ce que génère le delta |
| --- | --- | --- |
| `RecordType` supprimé | `Cannot delete record type through API` | XML avec `active=false` dans le dossier à déployer + warning |
| `RecordType` supprimé avec son objet | `last active record type` si on le désactive | rien : il part avec l'objet |
| `Flow` supprimé | suppression par nom refusée | `FlowDefinition` `activeVersionNumber=0` + warning |
| Fichier `Translations` supprimé | la langue entière serait visée | jamais dans `destructiveChanges.xml`, warning |
| Un fichier `fieldTranslation` supprimé | non adressable seul ; le parent serait supprimé | rien de destructive, warning |
| `CustomObject` supprimé | lister aussi ses workflows provoque `UNKNOWN_EXCEPTION` | seuls l'objet et ses `QuickAction` sont listés ; champs, list views, layouts, workflows, sharing rules partent en cascade |
| Un fichier d'un bundle supprimé (LWC, Aura, static resource, site Aura, vue LWR) | le composant existe toujours | redéploiement du bundle, pas de destructive |
| Une page d'un site LWR supprimée | `DigitalExperience` adressable | destructive de la vue / route seulement |
| Accès retiré d'un `PermissionSet` | le déploiement **remplace** le permission set | fichier complet (jamais de XML partiel) |
| Valeur retirée d'une picklist d'un `RecordType` | le déploiement remplace la liste de cette picklist | toutes les `picklistValues` du record type |
| Picklist entière retirée d'un `RecordType` | même le fichier complet la laisse dans l'org | rien |
| `RecordType` par défaut d'un profil supprimé | la désactivation passe | XML avec `active=false` |
| Élément retiré d'un `Profile` | le déploiement ne retire jamais ce que le XML ne cite pas | rien à déployer, warning qui nomme les éléments (passer l'accès à `false` pour le révoquer) |
| Valeur retirée d'une `GlobalValueSet` | la valeur reste dans l'org, désactivée (`isActive=false`) | fichier complet ; la suppression définitive se fait dans Setup |
| Objet Edit ou Delete muté dans un `MutingPermissionSet` | `invalid parameter value`, même en déployant le fichier complet | rien : limite Salesforce (muter l'Edit d'un champ passe) |
| `StandardValueSet` supprimé | `is standard and cannot be deleted` | rien de destructive, warning |
| `GlobalValueSet` utilisée par un champ supprimé | le champ reste 15 jours dans la corbeille et bloque | rien à faire côté delta : suppression après purge |

## Fichiers non commités

`--to` vaut `HEAD` par défaut, comme dans sfdx-git-delta : seul l'historique git compte. Les fichiers modifiés ou non
suivis du `--source-dir` restent hors du delta, et un warning les compte. Écart volontaire avec `sfdx mdt:git:delta`,
qui copiait les fichiers du disque quel que soit `--to` : le package mélangeait alors la liste d'une ref et le contenu
d'une autre.

## Fichiers qui ne sont pas des metadata

- Le `.forceignore` de chaque ref comparée est appliqué : les fichiers exclus n'entrent pas dans le delta.
- Un fichier que SDR ne reconnaît pas (`.gitkeep`, `README.md`, `jsconfig.json`...) produit un warning ; il n'interrompt
  plus le delta et n'est jamais deviné d'après son dossier.

## Gros fichiers XML

`diffCompositeXml` découpe d'abord les deux versions en éléments de premier niveau et écarte ceux qui sont identiques au
texte près ; seuls les éléments qui diffèrent passent par le parser XML. Un profil de 23 Mo (150 000 permissions de
champs) passe de 33 s à 1,5 s. Les collections sans règle de clé sont conservées entières dès qu'un élément change, pour
garder le même résultat qu'un diff complet.

## Fallback générique

### `GenericFileStrategy`

Fichier : [`src/delta/strategies/generic-file-strategy.ts`](../src/delta/strategies/generic-file-strategy.ts)

- Sert de dernière stratégie du registre.
- Réutilise le metadata déjà résolu par le moteur.
- Copie tous les fichiers contenus dans le composant résolu, sauf pour un composant décomposé (`CustomObject`,
  `CustomObjectTranslation`, `Bot`) : SDR résout chacun de ses fichiers vers le composant entier, mais seuls le fichier
  modifié et le fichier parent exigé par le déploiement partent (`X.object-meta.xml` modifié seul : ce fichier seul ;
  `fieldTranslation` modifiée : elle et son `.objectTranslation`). Déployer le parent ne retire pas les enfants qu'il
  n'emporte pas (vérifié en sandbox pour les traductions de champs, `test/e2e-org/metadata-lifecycle.org.e2e.test.ts`).
- Pour un delete, ajoute seulement l'entrée au manifest destructive, sauf si le fichier supprimé n'est qu'une partie d'un
  composant décomposé qui existe toujours (ex. `fieldTranslation`) : warning seulement.
- Exclut les dossiers `__tests__` des bundles LWC (tests Jest non déployables).
- Ne liste jamais un `StandardValueSet` supprimé (l'API refuse de le supprimer) : warning seulement.

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
