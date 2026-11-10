# VTC Villers Cotterêts — site & module de réservation

Site statique (HTML/CSS/JS, aucune dépendance) intégrant un module de réservation
codé directement dans la page, branché sur l'**API publique RBS** (Ride Booking System) :
pas de widget ni d'iframe. RBS gère prix, créneaux, paiement et notifications.

- Documentation API : https://ridebookingsystem.com/docs/api
- Base URL : `https://ridebookingsystem.com/api`
- Tenant ID : `c24716e1-b673-4360-af88-f307a64e5947`

## Fichiers

| Fichier | Rôle |
| --- | --- |
| `index.html` | Page d'accueil avec le module de réservation (`#reservation`) |
| `assets/rbs-booking.js` | Module de réservation (client API + formulaire) |
| `assets/rbs-booking.css` | Styles du module (préfixe `.rbs`, autonome) |
| `assets/site.css` | Styles du site (police Outfit, dégradé indigo → rose) |
| `assets/img/` | Logo (`logo-mark.svg`) et photos (`hero.jpg`, `aeroport.jpg`, `gare.jpg`, `urgence.jpg`) |
| `booking-success/` | Page de retour Stripe après paiement en ligne (vérifie le statut) |
| `booking-cancel/` | Page de retour Stripe en cas d'abandon du paiement |

## Intégrer le module dans n'importe quelle page

```html
<link rel="stylesheet" href="assets/rbs-booking.css">
<script src="assets/rbs-booking.js" defer></script>

<div data-rbs-booking data-tenant-id="c24716e1-b673-4360-af88-f307a64e5947"></div>
```

Options du conteneur :

- `data-rbs-layout="compact"` : la carte « Où souhaitez-vous aller ? » (départ, destination,
  date) s'affiche seule ; le reste du formulaire s'ouvre au clic sur « Réserver mon trajet ».
- `data-rbs-title="…"` : titre de la carte.
- `data-rbs-theme="site"` : utilise les couleurs du site (variables `--rbs-*` définies dans
  `assets/site.css`) au lieu de la couleur configurée dans RBS.

## Photos

Photos HD (créations générées par IA, scènes fictives) redimensionnées pour le web :
`hero.jpg` (1400 px), `aeroport.jpg`, `gare.jpg`, `urgence.jpg` (900 px, format 3:2).
Pour en changer, gardez les mêmes noms et augmentez le `?v=` des balises `<img>` dans `index.html`.

## Endpoints utilisés

| Méthode | Endpoint | Usage |
| --- | --- | --- |
| GET | `/public/widget/{tenant_id}` | Configuration : catégories (capacité `max_seats` / `max_luggage`), options, modes de paiement, types de trajet, pause des réservations |
| GET | `/public/maps/autocomplete?q=…&tenant_id=…` | Autocomplétion d'adresses (proxy Google Places) |
| GET | `/public/maps/place-details?place_id=…&tenant_id=…` | Coordonnées de l'adresse choisie |
| POST | `/public/quote-all-categories` | Prix en temps réel pour chaque catégorie (options et code promo inclus) |
| POST | `/public/booking` | Création de la réservation (confirmation email/SMS envoyée par RBS) |
| POST | `/public/payment/checkout` | Session Stripe si paiement `card_online`, puis redirection |
| GET | `/public/payment/status/{session_id}` | Vérification du paiement (page `booking-success`) |
| POST | `/public/payment/cancel` | Signalement d'un paiement abandonné (page `booking-cancel`) |

## Fonctionnalités

- Aller simple / aller-retour / mise à disposition, selon les types activés dans RBS
- Autocomplétion d'adresses au clavier, inversion départ/arrivée
- Prix affiché pour chaque véhicule, recalculé à chaque modification
- Nombre de passagers et de bagages borné à la capacité du véhicule choisi
- Options (ex. siège enfant), n° de vol/train, informations complémentaires, code promo
- Modes de paiement issus de la configuration (à bord ou en ligne via Stripe)
- Message de pause si les réservations sont suspendues dans RBS
- Récapitulatif de confirmation après réservation

## Mise à jour et cache

Les fichiers CSS/JS sont appelés avec un numéro de version (`assets/site.css?v=…`).
**À chaque modification d'un CSS ou JS, augmentez ce numéro** dans `index.html` et dans
les pages `booking-success/` et `booking-cancel/`, sinon les visiteurs peuvent garder
l'ancienne version en cache. Le fichier `.htaccess` force la revalidation des pages HTML.

## À compléter

- Pages **Mentions légales**, **Confidentialité** et **Cookies** (obligatoires) : les liens du
  pied de page pointent pour l'instant vers `#`.

## Tester en local

```bash
python3 -m http.server 8000
```

puis ouvrir http://localhost:8000. Attention : valider le formulaire crée une **vraie**
réservation dans RBS.

## Déploiement automatique (GitHub → Hostinger)

Le workflow `.github/workflows/deploy-hostinger.yml` envoie le site par FTP dans
`public_html` à chaque mise à jour de la branche `main` (ou manuellement depuis l'onglet
**Actions** → *Déploiement Hostinger* → *Run workflow*).

Secrets à créer une fois dans GitHub (**Settings → Secrets and variables → Actions**),
avec les informations de hPanel (**Sites web → domaine → Fichiers → Comptes FTP**) :

| Secret | Exemple |
| --- | --- |
| `FTP_SERVER` | `ftp.votre-domaine.fr` |
| `FTP_USERNAME` | `u123456789.votre-domaine.fr` |
| `FTP_PASSWORD` | mot de passe FTP |
| `FTP_SERVER_DIR` | facultatif, par défaut `public_html/` |

Sans ces secrets, le workflow s'exécute sans rien envoyer.

## Paiement en ligne

Le module envoie `origin_url = window.location.origin` à RBS ; Stripe renvoie ensuite le
client sur `/booking-success?session_id=…` ou `/booking-cancel?…` à la racine du domaine.
Le site doit donc être publié à la racine du domaine pour que ces pages soient trouvées.
