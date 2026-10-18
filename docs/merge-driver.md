# `sf df git merge-driver`

Commandes : [`src/commands/df/git/merge-driver/`](../src/commands/df/git/merge-driver/). Moteur :
[`src/merge/`](../src/merge/).

## Pourquoi

git fusionne les XML ligne à ligne. Sur un profil, deux branches qui ajoutent chacune un `fieldPermissions` au même
endroit sont en conflit, et le conflit couvre souvent plusieurs éléments sans rapport. Or ces collections sont des
ensembles identifiés par une clé (le `field` d'un `fieldPermissions`, le `fullName` d'un label) : on peut les fusionner
élément par élément.

## Installation

```bash
sf df git merge-driver install
```

1. Déclare le driver `deltaforce` dans la config git **locale** (`merge.deltaforce.driver`), qui n'est pas versionnée :
   chaque clone lance la commande une fois.
2. Ajoute à `.gitattributes` une ligne `<motif> merge=deltaforce` par type géré. Ce fichier est versionné : le commiter
   pour que toute l'équipe utilise le driver. Une machine sans le driver configuré garde la fusion ligne à ligne.
3. Relancée, la commande n'ajoute que ce qui manque. `sf df git merge-driver uninstall` retire le driver et ses lignes.

git appelle ensuite `sf df git merge-driver run` pour chaque fichier modifié des deux côtés, avec l'ancêtre commun
(`%O`), la version courante (`%A`, qui reçoit le résultat), l'autre version (`%B`), la taille des marqueurs (`%L`) et
le chemin (`%P`). Code de sortie 1 s'il reste des conflits : git marque alors le fichier en conflit.

## Types gérés

| Type | Clés |
| --- | --- |
| Profile | celles de [`PROFILE_COLLECTION_KEYS`](../src/delta/strategies/profile-strategy.ts), partagées avec le delta |
| Translations | celles de [`TRANSLATIONS_COLLECTION_KEYS`](../src/delta/strategies/translations-strategy.ts) |
| PermissionSet, CustomObjectTranslation | [`merge-rules.ts`](../src/merge/merge-rules.ts) |
| CustomLabels, Workflow, SharingRules, AssignmentRules, AutoResponseRules, EscalationRules, MatchingRules | `uniqueIdElement` du registre SDR, comme le delta |

Les motifs de `.gitattributes` viennent du suffixe SDR de chaque type (`*.profile-meta.xml`...). Le type d'un fichier
est lu sur son élément racine, pas sur son nom.

## Algorithme

1. Les trois versions sont découpées en éléments de premier niveau sans parse complet (`splitTopLevel` de
   [`xml.ts`](../src/delta/xml.ts)), comme pour le delta : un profil de 50 000 `fieldPermissions` fusionne en ~1 s.
2. Chaque élément est identifié par son tag et sa clé. Les éléments sans clé (`custom`, `userLicense`, `label`...) sont
   regroupés par tag et fusionnés comme un tout.
3. Fusion à trois voies par élément, en ignorant les blancs entre les balises :

   | Ancêtre | Courante | Autre | Résultat |
   | --- | --- | --- | --- |
   | absent | présent | absent | courante |
   | absent | absent | présent | autre |
   | absent | X | Y | conflit si X ≠ Y |
   | B | B | Y | autre |
   | B | X | B | courante |
   | B | X | Y | conflit si X ≠ Y |
   | B | absent | B | supprimé |
   | B | B | absent | supprimé |
   | B | absent | Y | conflit |
   | B | X | absent | conflit |

4. L'ordre est celui de la version courante. Un élément ajouté par l'autre côté est placé après l'élément qui le
   précède chez lui ; les ajouts de la version courante au même endroit sont sautés tant qu'ils sont avant lui dans
   l'ordre des clés. Deux fichiers triés (comme Salesforce les écrit) donnent un fichier trié.
5. Un conflit est écrit avec les marqueurs habituels de git, autour de l'élément concerné uniquement. Les fins de
   ligne (LF ou CRLF) et les commentaires entre éléments sont conservés.

## Repli sur la fusion ligne à ligne

Le fichier est confié à `git merge-file` (même résultat que git sans driver) quand il ne peut pas être fusionné par
clé :

- type non géré, ou XML mal formé (par exemple des marqueurs de conflit déjà présents) ;
- deux éléments avec la même clé dans une version ;
- les deux côtés ont changé différemment l'en-tête (déclaration XML, attributs de l'élément racine).

## Tests

- [`test/merge/xml-merge.test.ts`](../test/merge/xml-merge.test.ts) : chaque ligne du tableau, ordre, CRLF,
  commentaires, repli, garde-fou de performance.
- [`test/merge/driver.test.ts`](../test/merge/driver.test.ts) : écriture du résultat et repli sur `git merge-file`.
- [`test/commands/df/git/merge-driver.test.ts`](../test/commands/df/git/merge-driver.test.ts) : install / uninstall
  sur un dépôt temporaire, code de sortie de `run`.
- [`test/commands/df/git/merge-driver.nut.ts`](../test/commands/df/git/merge-driver.nut.ts) : un vrai `git merge`
  qui appelle le driver (`npm run test:nuts`, après `npm run compile`).
