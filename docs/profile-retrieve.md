# `sf df profile retrieve`

Commande : [`src/commands/df/profile/retrieve.ts`](../src/commands/df/profile/retrieve.ts). Moteur :
[`src/retrieve/`](../src/retrieve/).

## Pourquoi une commande

`sf project retrieve start -m Profile:X` ne renvoie que les accès aux composants récupérés dans la même requête.
Mesuré sur une sandbox de 610 profils (API 64.0), profil `Admin` :

| | Retrieve natif seul | `readMetadata` |
| --- | --- | --- |
| `classAccesses` | 31 | 1942 |
| `fieldPermissions` | 448 | 7019 |
| `layoutAssignments` | 2 | 1154 |
| `objectPermissions` | 3 | 804 |

Pour obtenir le profil complet nativement, il faut tout récupérer avec lui. La commande lit donc le profil avec
`readMetadata`, qui le renvoie en entier.

Les traductions n'ont **pas** ce problème : `Translations:fr` récupéré seul (28 s) est identique à l'octet près au
fichier obtenu avec tous les composants traduisibles (202 s), commentaires `<!-- libellé maître -->` compris. Même
chose pour `CustomObjectTranslation:Account-fr` (19 s seul, 68 s avec `CustomObject:Account`). D'où l'absence de
`translations retrieve`.

## Flags alignés sur `sf project retrieve start`

Mêmes noms, mêmes lettres, mêmes exclusions que `sf project retrieve start` (`-o`, `-a`, `-d`, `-m`, `-x`, `-r`).

- `-d`, `-m` et `-x` s'excluent. Sans aucun des trois : tous les profils des `packageDirectories` du projet.
- `-m Profile` = tous les profils de l'org ; `-m "Profile:Sales*"` résout le joker sur l'org (`listMetadata`), comme le
  natif. Un nom exact n'interroge pas l'org. `-m` refuse un autre type.
- `-x` ne garde que les membres `Profile` du manifeste ; `*` = tous les profils de l'org.
- Un profil déjà dans le projet est écrasé sur place, même si son nom est donné décodé (`+` pour `%2B`). Un nouveau va
  dans `<package par défaut>/main/default/profiles`.
- `-r` écrit dans `<output-dir>/profiles`, comme le natif (avant : à plat dans `<output-dir>`).
- Écart volontaire : le natif interdit `-r` avec `-d`. Ici c'est permis, pour ne pas casser `--sourcepath` +
  `--outputdir` hérités de `mdt:profile:retrieve`.
- `listMetadata` passe par le même SOAP brut que `readMetadata` : `connection.metadata.list` de jsforce a son propre
  transport, sans le rafraîchissement de session ni les reprises.

## Comment

1. Les profils sont trouvés par SDR (`ComponentSet.fromSource`). Le nom complet est le nom de fichier encodé
   (`System Admin %2B Bulk Delete Permission`), qui est aussi le nom attendu par l'API. Les autres fichiers sont
   ignorés.
2. Un appel `readMetadata` SOAP **par profil**, 5 en parallèle. L'org traite en série les profils d'un même appel :
   6 profils en un appel = 67 s, en 6 appels parallèles = 27 s.
3. La réponse est gardée en **texte brut** (`responseType: 'text/plain'`) : jsforce construirait un gros arbre d'objets
   (16 s au lieu de 7,5 s pour un profil de 1,6 Mo) et caste certains booléens mais pas d'autres. Le XML de la réponse
   est déjà dans l'ordre et avec l'échappement du retrieve : il est seulement réindenté, sans parse.
4. Chaque profil est écrit dès qu'il arrive, dans un fichier temporaire renommé ensuite : une commande interrompue ne
   laisse jamais de profil tronqué. 50 profils (97 Mo) passent avec le tas limité à 128 Mo.
5. Une erreur passagère (connexion coupée, HTTP 5xx, `UNKNOWN_EXCEPTION`, `SERVER_UNAVAILABLE`,
   `REQUEST_LIMIT_EXCEEDED`) est rejouée 3 fois (2 s, 4 s, 8 s). Une erreur de la requête ne l'est pas.
6. Les appels parallèles qui voient la session expirer partagent un seul rafraîchissement.

## Limite : le profil contient tous les accès de l'org

`readMetadata` renvoie les accès à **tous** les composants de l'org, pas seulement à ceux du projet : champs de
packages gérés, champs créés directement dans la sandbox... Déployer ce profil dans une org où l'un d'eux manque
échoue (`no CustomField named X found`). `mdt:profile:retrieve` avait le même comportement. Récupérer depuis une org
alignée sur la cible, ou retirer ces entrées avant de déployer.

## Règles vérifiées en sandbox

Tests : `test/delta/sandbox-findings.test.ts` (« profile retrieve ») et
`test/e2e-org/profile-retrieve.org.e2e.test.ts`.

- Chaque élément d'un profil récupéré nativement se retrouve, identique et dans le même ordre, dans le profil écrit
  par la commande (`Admin`, `CZE - Marketing Profile`, `System Admin %2B Bulk Delete Permission`, et 3 profils dont la
  description contient des `"` et des retours `\r\n`).
- Un profil inconnu de l'org revient en `<records xsi:nil="true"/>`. Le fichier local n'est pas touché et la commande
  sort en 1 : `mdt:profile:retrieve` écrivait un profil vide par-dessus, qui retirait tous les accès au déploiement
  suivant.
- Le jeton de session voyage dans l'enveloppe SOAP, que jsforce ne rafraîchit pas : sur `INVALID_SESSION_ID`, la
  commande rafraîchit le jeton et rejoue l'appel une fois.

Écarts volontaires avec `mdt:profile:retrieve` : `test/delta/mdt-parity.test.ts` (« mdt:profile:retrieve parity »).
