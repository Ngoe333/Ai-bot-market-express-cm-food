const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');

// 🌟 SECURE FIREBASE URL FROM GITHUB SECRETS 🌟
const FIREBASE_URL = process.env.FIREBASE_URL;

const orderStates = {}; 

// Function to fetch the dynamic menu from your App's Firebase
async function getMenuFromApp() {
    try {
        const response = await fetch(`${FIREBASE_URL}/dishes.json`);
        const data = await response.json();
        if (!data) return[];
        
        // Convert Firebase object into an array (now includes imageUrl)
        return Object.keys(data).map(key => ({
            id: key,
            name: data[key].name,
            price: data[key].price,
            imageUrl: data[key].imageUrl
        }));
    } catch (error) {
        console.error("Failed to fetch menu:", error);
        return[];
    }
}

async function startBot() {
    if (!FIREBASE_URL) {
        console.log("❌ ERROR: FIREBASE_URL is missing in GitHub Secrets!");
        process.exit(1);
    }

    const { state, saveCreds } = await useMultiFileAuthState('session_data');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser:["S", "K", "1"] 
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.clear(); 
            console.log('\n==================================================');
            console.log('⚠️ QR CODE TOO BIG? CLICK "View raw logs" in top right!');
            console.log('==================================================\n');
            qrcode.generate(qr, { small: true }); 
        }

        if (connection === 'open') console.log('✅ MARKET EXPRESS CM FOOD AI EST EN LIGNE !');
        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            if (reason !== DisconnectReason.loggedOut) startBot();
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;
        if (msg.key.fromMe) return; // Loop Protection

        const sender = msg.key.remoteJid;
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").toLowerCase();

        console.log(`📩 Query: ${text}`);

        // --- 🛒 STEP 2: FINISH ORDER & SEND TO ADMIN PANEL ---
        if (orderStates[sender]?.step === 'WAITING_FOR_ADDRESS') {
            const customerDetails = text; // This now contains Name, Phone, and Address
            const item = orderStates[sender].item;
            const customerWaNumber = sender.split('@')[0];

            // Match the exact format of your JavaGoat Admin Panel
            const javaGoatOrder = {
                userId: "whatsapp_" + customerWaNumber,
                userEmail: "whatsapp@javagoat.com",
                phone: customerWaNumber, // Keeps their WA number registered
                address: customerDetails, // Saves Name, Phone, and Address typed by them
                location: { lat: 0, lng: 0 },
                items:[{
                    id: item.id,
                    name: item.name,
                    price: parseFloat(item.price),
                    img: item.imageUrl || "",
                    quantity: 1
                }],
                total: (parseFloat(item.price) + 50).toFixed(2), // Price + 50 Delivery Fee
                status: "Placé",
                method: "Paiement à la livraison (WhatsApp)",
                timestamp: new Date().toISOString()
            };

            // Save order securely via REST API
            try {
                await fetch(`${FIREBASE_URL}/orders.json`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(javaGoatOrder)
                });
            } catch (error) {
                console.log("Firebase Error: ", error);
            }

            await sock.sendMessage(sender, { text: `✅ *Votre commande a bien été enregistrée !* \n\nMerci ! Votre commande *${item.name}* est en cours de préparation. \n\n*Total:* FCFA${javaGoatOrder.total} (Inc. Livraison)\n*Status:* Préparation\n\nNous vous le livrerons à votre adresse d'ici 20 minutes ou 30minute.` });
            delete orderStates[sender]; 
            return;
        }

        // --- 🌟 STEP 1: START ORDER FLOW (WITH IMAGE & PHONE REQUEST) ---
        if (text.startsWith("commande ")) {
            const productRequested = text.replace("commande ", "").trim().toLowerCase();
            const currentMenu = await getMenuFromApp();
            
            // Search the live database for the requested item
            const matchedItem = currentMenu.find(item => item.name.toLowerCase().includes(productRequested));

            if (!matchedItem) {
                await sock.sendMessage(sender, { text: `❌ Désolé, nous n'avons pas trouvé *${productRequested}* dans notre menu d'aujourd'hui.\n\nTapez *menu* pour voir tous les plats disponibles.` });
                return;
            }

            orderStates[sender] = { step: 'EN ATTENTE D"ADRESSE', item: matchedItem };
            
            // 🌟 NEW: SEND PRODUCT IMAGE + ASK FOR PHONE NUMBER 🌟
            const captionText = `🛒 *Commande en cours !* \n\nVous avez sélectionné: *${matchedItem.name}* (FCFA${matchedItem.price})\n\nMerci de nous indiquer dans votre réponse votre *nom complet, votre numéro de téléphone et votre adresse de livraison.*.`;
            
            // If the product has an image URL in Firebase, send it as a WhatsApp Photo
            if (matchedItem.imageUrl) {
                await sock.sendMessage(sender, { 
                    image: { url: matchedItem.imageUrl }, 
                    caption: captionText 
                });
            } else {
                // Fallback if no image is found
                await sock.sendMessage(sender, { text: captionText });
            }
        }
        else if (text === "commande") { 
            await sock.sendMessage(sender, { text: "🛒 *Comment commander :* \nVeuillez taper « commande » suivi du nom du plat. \nExemple : *commande Eru & fufu*" });
        }
        
        // --- DYNAMIC MENU FEATURE ---
        else if (text.includes("menu") || text.includes("prix") || text.includes("list") || text.includes("food")) {
            const currentMenu = await getMenuFromApp();
            
            if (currentMenu.length === 0) {
                await sock.sendMessage(sender, { text: "Notre menu est actuellement vide ou en cours de mise à jour. Revenez bientôt !" });
                return;
            }

            let menuMessage = "🍔 *MARKET EXPRESS CM FOOD LIVE MENU* 🍕\n\n";
            currentMenu.forEach(item => {
                menuMessage += `🔸 *${item.name}* - FCFA${item.price}\n`;
            });
            menuMessage += "\n_Pour commander, répondre par 'commande [dish name]'_";
            
            await sock.sendMessage(sender, { text: menuMessage });
        }

        // --- GREETINGS ---
        else if (text.includes("Bonjour") || text.includes("Salut") || text.includes("Bonsoir") || text.includes("Manger") || text.includes("bonjour") || text.includes("bonsoir") || text.includes("salut")) {
            await sock.sendMessage(sender, { text: "👋 *Bienvenu chez Market Express cm Food!* \n\nJe suis votre assistant IA. Tapez *menu* pour découvrir nos délicieux plats, ou tapez *commander [un plat]* pour les acheter immédiatement !" });
        }
        else if (text.includes("contact") || text.includes("call")) {
            await sock.sendMessage(sender, { text: "📞 *Contact Market Express cm Food:* \n\n- *Email:* support@marketexpresscm.com  \n\n- *Numero:* 657899435" });
        }
        else {
            await sock.sendMessage(sender, { text: "🤔 Je n'ai pas bien compris ça.\n\nTapez *menu* pour consulter notre carte, ou *commande [plat]* pour passer une commande !" });
        }
    });
}

startBot().catch(err => console.log("Error: " + err));
