let zlib: any;

if (typeof window === "undefined") {
  // Import zlib only in the Node.js (server-side) environment, best working workaround I found so far
  // should actually be fixable with fallbacks like browserify-zlib in next.config webpack config, but somehow that did not work...
  zlib = require("zlib");
}

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import {
  Connection,
  PublicKey,
  Transaction,
  Keypair,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  getAccount,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import { create, fetchCollection } from "@metaplex-foundation/mpl-core";
import {
  generateSigner,
  createSignerFromKeypair,
  signerIdentity,
  publicKey,
} from "@metaplex-foundation/umi";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { base58 } from "@metaplex-foundation/umi/serializers";
import {
  irysUploader,
  // @ts-ignore "type definitions are missing"
} from "@metaplex-foundation/umi-uploader-irys";

import { encryptText } from "@/app/utils/server/encrypt";
import { createMetadata } from "@/app/utils/server/createMetadata";
import { uploadNFTImageToArweave } from "@/app/utils/server/uploadToArweave";

// Function to find or create an associated token account
async function getOrCreateAssociatedTokenAccount(
  connection: Connection,
  mintAddress: PublicKey,
  owner: PublicKey,
  payer: Keypair
) {
  const associatedTokenAddress = await Token.getAssociatedTokenAddress(
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    mintAddress,
    owner
  );

  // Check if the token account already exists
  const tokenAccountInfo = await connection.getAccountInfo(
    associatedTokenAddress
  );

  // If it doesn't exist, create it
  if (!tokenAccountInfo) {
    const transaction = new Transaction().add(
      Token.createAssociatedTokenAccountInstruction(
        ASSOCIATED_TOKEN_PROGRAM_ID,
        TOKEN_PROGRAM_ID,
        mintAddress,
        associatedTokenAddress,
        owner,
        payer.publicKey
      )
    );
    await sendAndConfirmTransaction(connection, transaction, [payer]);
  }

  return associatedTokenAddress;
}

/* TODO:
-protect the route with a secret key or sth.
-validate the request body
-what's with batch uploads?
*/

// const secretKey = new Uint8Array(
//   process.env
//     .DEV_WALLET_SECRET_KEY!.replace("[", "")
//     .replace("]", "")
//     .split(",")
//     .map(Number)
// );
// const keypair = Keypair.fromSecretKey(secretKey); // Create the Keypair
// const ourPublicKey = keypair.publicKey.toString(); // Get the public key
// console.log("Public Key:", ourPublicKey);

export async function POST(req: NextRequest) {
  if (req.method === "POST") {
    const { author, title, text, published_at, published_where, user_wallet } =
      await req.json(); // what to include in request body

    // Validate required fields
    if (
      !author ||
      !title ||
      !text ||
      !published_at ||
      !published_where ||
      !user_wallet
    ) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    if (!process.env.COLLECTION_PUBKEY) {
      return NextResponse.json(
        {
          error:
            "Collection public key is not defined in the environment variables",
        },
        { status: 500 }
      );
    }

    if (!process.env.DEV_WALLET_SECRET_KEY) {
      throw new Error(
        "DEV_WALLET_SECRET_KEY is not defined in the environment variables"
      );
    }

    try {
      // Create Signer from Wallet Secret Key
      const secretKeyArray = JSON.parse(
        process.env.DEV_WALLET_SECRET_KEY
      ) as number[];
      const secretKey = new Uint8Array(secretKeyArray);
      const umi = createUmi("https://api.devnet.solana.com", "finalized");
      let keypair = umi.eddsa.createKeypairFromSecretKey(
        new Uint8Array(secretKey)
      );
      const adminSigner = createSignerFromKeypair(umi, keypair);
      umi.use(signerIdentity(adminSigner)).use(irysUploader());

      // Generate the Asset KeyPair
      const asset = generateSigner(umi);
      const assetPublicKey = new PublicKey(asset.publicKey);
      console.log("This is your asset address", assetPublicKey);

      // Pass and Fetch the Collection
      const collection = await fetchCollection(
        umi,
        publicKey(process.env.COLLECTION_PUBKEY)
      );

      // Upload ctrl-x icon to arweave
      let imageUri = process.env.NFT_IMAGE_AW_URL;
      if (!imageUri) {
        imageUri = await uploadNFTImageToArweave(umi);
      }

      // Compress & Encrypt the text
      // for decompressing: zlib.inflateSync(Buffer.from(compressedText, "base64")).toString();
      const compressedText = zlib.deflateSync(text).toString("base64");
      const encryption = encryptText(compressedText);

      // Generate Metadata
      const metadata = createMetadata({
        title,
        imageUri,
        author,
        published_at,
        published_where,
        encryption,
      });

      // Upload Metadata
      const metadataUri = await umi.uploader.uploadJson(metadata);
      console.log({ metadataUri });

      // Generate the Asset
      const tx = await create(umi, {
        asset,
        collection,
        name: title,
        uri: metadataUri,
      }).sendAndConfirm(umi);

      // ********

      // Establish Connection
      const connection = new Connection("https://api.devnet.solana.com");

      // Get or create associated token account for user wallet
      // Assuming the minted NFT is tied to this mint address
      const userWalletPublicKey = new PublicKey(user_wallet);
      const associatedTokenAddress = await getAssociatedTokenAddress(
        assetPublicKey,
        userWalletPublicKey,
        false,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );

      try {
        // Check if the token account exists for the user's wallet
        await getAccount(connection, associatedTokenAddress);
        console.log(
          "Token account exists for the user's wallet:",
          associatedTokenAddress.toString()
        );
      } catch (err) {
        console.log("Token account does not exist, creating a new one...");
        const ataCreationInstruction = createAssociatedTokenAccountInstruction(
          new PublicKey(keypair.publicKey), // Payer
          associatedTokenAddress, // ATA to create
          userWalletPublicKey, // The user's wallet that will receive the NFT
          assetPublicKey, // Mint address (the asset)
          TOKEN_PROGRAM_ID, // Token program ID
          ASSOCIATED_TOKEN_PROGRAM_ID
        );

        // Add this instruction to the transaction
        const tx = new Transaction().add(ataCreationInstruction);

        // Set the fee payer for the transaction
        tx.feePayer = new PublicKey(keypair.publicKey);

        // Extract the blockhash for the transaction
        const blockhashInfo = await connection.getLatestBlockhash();
        tx.recentBlockhash = blockhashInfo.blockhash;
        try {
          // Sign and send the transaction to create the associated token account
          const signature = await sendAndConfirmTransaction(connection, tx, [
            Keypair.fromSecretKey(secretKey),
          ]);

          console.log("Associated token account created:", signature);
        } catch (err) {
          // @ts-ignore
          const bla = await err?.getLogs();
          console.log("Error creating associated token account:", bla);
        }
      }
      // ********

      // Deserialize the Signature from the Transaction
      return NextResponse.json(
        {
          message: `Asset Created: https://solana.fm/tx/${
            base58.deserialize(tx.signature)[0]
          }?cluster=devnet-alpha`,
        },
        { status: 200 }
      );
    } catch (error) {
      console.log({ error });
      return NextResponse.json({ error: "Mint failed" }, { status: 500 });
    }
  } else {
    // If not POST, return method not allowed
    return NextResponse.json({ error: "Method not allowed" }, { status: 405 });
  }
}
