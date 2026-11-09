# Politique de confidentialité

*English version: [PRIVACY.md](PRIVACY.md)*

**Date d'entrée en vigueur :** 8 novembre 2026

La présente politique explique quels renseignements personnels WageRoute recueille (pour ainsi dire aucun) et où vont vos renseignements lorsque vous utilisez l'application, l'application mobile, le site Web et les services qui les entourent. Elle vise à respecter la *Loi sur la protection des renseignements personnels et les documents électroniques* (LPRPDE) du Canada et la *Loi sur la protection des renseignements personnels dans le secteur privé* du Québec (telle que modifiée par la Loi 25), et à répondre aux questions que posent le RGPD de l'Union européenne et du Royaume-Uni ainsi que les lois des États américains sur la protection de la vie privée.

WageRoute est conçu par Xavier Voet (« nous »), un développeur indépendant établi au Québec, au Canada.

## En bref

- **L'application WageRoute ne recueille rien.** Votre registre, vos paramètres et tout ce que vous saisissez restent dans des fichiers sur votre propre ordinateur. L'application n'a pas de compte, n'envoie aucune télémétrie ni statistique d'utilisation, n'effectue aucune requête réseau et n'a aucun serveur qui pourrait recevoir vos données.
- **Nous ne voyons jamais vos données financières** et n'avons aucun moyen de les voir.
- **Le site Web ne dépose aucun témoin (cookie)** et n'utilise aucun outil d'analyse ni de suivi. Il conserve un seul paramètre dans votre navigateur : votre choix de thème clair ou sombre.
- Certains services qui distribuent WageRoute (GitHub, Homebrew, le Gestionnaire de paquets Windows, Buy Me a Coffee) sont exploités par d'autres entreprises, selon leurs propres politiques de confidentialité. Ils sont énumérés plus bas.

## 1. L'application de bureau

WageRoute est une application de bureau locale pour macOS, Windows et Linux.

- **Où se trouvent vos données.** Votre registre est un fichier SQLite dans votre dossier d'utilisateur : `~/Library/Application Support/WageRoute` sur macOS, `%APPDATA%\WageRoute` sur Windows et `~/.config/WageRoute` sur Linux. Il peut aussi se trouver dans un dossier que vous choisissez dans les Paramètres. L'application y conserve aussi des copies de sécurité locales (`backups/`) et un journal d'erreurs local. Rien de tout cela n'est transmis.
- **Aucun réseau.** L'application ne se connecte pas à Internet. Elle ne contient aucun code d'analyse, de rapport d'erreurs, de vérification de mise à jour, de publicité ni de suivi. Le seul lien externe de l'application ouvre notre page Buy Me a Coffee dans votre propre navigateur, et seulement si vous cliquez dessus.
- **Le chiffrement, si vous l'activez.** Lorsque vous activez le chiffrement au repos, la clé est conservée à côté de votre registre dans `ledger.key.json`, protégée au choix par le trousseau de votre ordinateur ou par une phrase de passe (les versions récentes ajoutent un NIP et, lorsque c'est pris en charge, une clé d'accès par empreinte digitale ou reconnaissance faciale). La phrase de passe et le NIP ne sont jamais conservés, et rien ne nous est jamais transmis. **Nous ne pouvons pas récupérer une phrase de passe ou un NIP oublié**, puisque nous ne les avons jamais eus.
- **Les exportations et importations** sont des fichiers que vous créez et enregistrez où vous le voulez. Ils contiennent vos données financières : traitez-les comme des documents sensibles.

## 2. WageRoute Pocket (l'application mobile)

Pocket est une application Web facultative qui fonctionne dans le navigateur de votre téléphone.

- Elle conserve sa copie de vos données dans le stockage de votre navigateur (IndexedDB) sur cet appareil, et ne la téléverse jamais. Les données passent de votre téléphone à votre ordinateur uniquement dans des fichiers de sauvegarde que vous transportez vous-même.
- Pocket est composée de fichiers statiques, sans serveur applicatif. Quiconque **héberge** ces fichiers (vous, si vous l'hébergez vous-même, ou l'hébergeur que vous choisissez) peut voir les journaux habituels d'un serveur Web, comme votre adresse IP et votre type de navigateur, mais jamais votre registre.

## 3. Le site Web (revax-2007.github.io/wageroute)

- **Hébergement.** Le site est hébergé par **GitHub Pages**. GitHub traite des renseignements techniques comme votre adresse IP pour afficher les pages et assurer la sécurité du service, conformément à la [déclaration de confidentialité de GitHub](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement). Nous ne recevons pas ces journaux.
- **Aucun témoin, aucun outil d'analyse, aucun traceur.** Le site ne charge rien qui provienne de tiers.
- **Un seul paramètre dans le navigateur.** Si vous choisissez Clair ou Sombre avec le sélecteur de thème, le site enregistre ce choix dans le `localStorage` de votre navigateur, sous la clé `wageroute-theme`. Ce choix ne quitte jamais votre navigateur. Choisir Auto le supprime.
- **Recherche.** Nous utilisons Google Search Console pour voir comment le site apparaît dans la recherche Google. Cet outil présente des statistiques de recherche, comme le nombre de fois où le site est apparu dans les résultats, que Google recueille sur ses propres pages de recherche selon les [Règles de confidentialité de Google](https://policies.google.com/privacy). Le site ne contient aucun code de suivi de Google ; une seule balise de vérification prouve que le site nous appartient.

## 4. Téléchargements et programmes d'installation

Vous obtenez WageRoute par des services exploités par d'autres entreprises, chacune ayant sa propre politique de confidentialité :

- **GitHub** héberge le code source, les versions publiées et les scripts d'installation ([déclaration de confidentialité de GitHub](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement)). Télécharger une version ou exécuter `install.sh` / `install.ps1` connecte votre ordinateur à GitHub.
- **Homebrew**, si vous installez avec `brew`, a sa propre [politique de statistiques](https://docs.brew.sh/Analytics), que vous pouvez désactiver avec `brew analytics off`.
- Le **Gestionnaire de paquets Windows** (`winget`), si vous l'utilisez, est exploité par Microsoft selon la [Déclaration de confidentialité de Microsoft](https://www.microsoft.com/fr-ca/privacy/privacystatement).

Les scripts d'installation ne recueillent rien et ne nous transmettent rien. Ils téléchargent la version depuis GitHub et l'installent sur votre ordinateur.

## 5. Auto-hébergement (Docker)

Si vous exécutez WageRoute dans vos propres conteneurs, c'est vous qui en êtes l'exploitant. Votre registre reste dans votre propre volume Docker, et la connexion ou le serveur mandataire que vous placez devant vous appartiennent. Rien ne nous est transmis.

## 6. Dons

Si vous choisissez de soutenir le projet, le paiement est traité entièrement par **Buy Me a Coffee**, selon sa [politique de confidentialité](https://www.buymeacoffee.com/privacy-policy). Nous recevons ce que la plateforme montre aux créateurs (habituellement votre nom d'affichage, votre message, s'il y a lieu, et le montant), et nous ne l'utilisons que pour voir votre soutien et vous en remercier.

## 7. Nous joindre sur GitHub

Si vous ouvrez un billet (issue) ou une demande de fusion (pull request), ce que vous publiez est public et traité par GitHub. Nous ne l'utilisons que pour vous répondre et améliorer WageRoute. **Ne publiez aucun renseignement personnel ou financier dans un billet.**

## 8. Vos droits

Selon les lois du Canada, du Québec, de l'Union européenne et du Royaume-Uni, ainsi que celles des États américains, vous pouvez avoir le droit d'accéder à vos renseignements personnels, de les faire rectifier, supprimer ou transférer, de retirer votre consentement et de porter plainte auprès d'une autorité de contrôle.

Comme l'application et le site Web ne recueillent aucun renseignement personnel, **nous ne détenons aucune donnée vous concernant qui puisse être consultée ou supprimée.** Les données de WageRoute se trouvent dans vos propres fichiers, dont vous avez l'entière maîtrise. Pour tout ce que vous nous avez fourni directement, comme une publication sur GitHub ou un message de don, communiquez avec nous (section 11) : nous vous aiderons dans un délai de 30 jours.

Nous ne vendons ni ne partageons aucun renseignement personnel, au sens que les lois des États américains donnent à ces termes, comme la *California Consumer Privacy Act*. Nous ne prenons aucune décision automatisée et ne faisons aucun profilage.

## 9. Enfants

WageRoute ne s'adresse pas aux enfants de moins de 14 ans, et nous ne recueillons sciemment de renseignements auprès de personne, quel que soit son âge.

## 10. Sécurité

Le modèle de sécurité de l'application, y compris le chiffrement au repos et ses limites, est décrit dans [docs/SECURITY.md](docs/SECURITY.md) (en anglais). Pour signaler une vulnérabilité, suivez les indications de [SECURITY.md](SECURITY.md).

## 11. Responsable et coordonnées

Le responsable de la protection des renseignements personnels (Québec, Loi 25) est **Xavier Voet**, le développeur de WageRoute.

- **Questions ou demandes :** ouvrez un billet à <https://github.com/ReVax-2007/wageroute/issues>.
- **Toute demande de nature privée :** ouvrez un billet qui indique seulement que vous avez une demande confidentielle relative à la vie privée, sans aucun détail, et nous conviendrons avec vous d'un moyen de communication privé.

Si notre réponse ne vous satisfait pas, vous pouvez vous adresser à la Commission d'accès à l'information du Québec (<https://www.cai.gouv.qc.ca>), au Commissariat à la protection de la vie privée du Canada (<https://www.priv.gc.ca>) ou à l'autorité de protection des données de l'endroit où vous vivez.

## 12. Modifications

Si la présente politique change, nous mettrons à jour la date d'entrée en vigueur ci-dessus, et l'historique de chaque modification est public dans ce dépôt. Nous ne commencerons jamais à recueillir des renseignements personnels sans l'indiquer ici au préalable.
